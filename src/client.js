const events = require('events');
const debug = require('debug');
const amqplib = require('amqplib');
const assert = require('assert');
const {URL} = require('url');

var clientCounter = 0;

/**
 * Build Pulse ConnectionString, from options on the form:
 * {
 *   username:          // Pulse username
 *   password:          // Pulse password
 *   hostname:          // Hostname to use
 * }
 */
const buildConnectionString = function({username, password, hostname}) {
  assert(username, 'options.username is required');
  assert(password, 'options.password is required');
  assert(hostname, 'options.hostname is required');

  // Construct connection string
  return [
    'amqps://',         // Ensure that we're using SSL
    encodeURI(username),
    ':',
    encodeURI(password),
    '@',
    hostname,
    ':',
    5671,                // Port for SSL
  ].join('');
};
exports.buildConnectionString = buildConnectionString;

/**
 * An object to create connections to a pulse server.  This class will
 * automatically handle reconnecting as necessary.
 *
 * AMQP is a very connection-oriented protocol.  For example, a client using
 * non- durable queues will need to re-declare those queues on every new
 * connection.  Similarly, a consumer must re-start consumption on every new
 * connection.  This class emits a `connected` event on each new
 * connection, and that function should re-establish any state as required for
 * the new connection.
 *
 * Connections are automatically cycled periodically, regardless of any problems
 * with the connection itself, in order to exercise the reconnection logic. When
 * this occurs, the old connection is held open for 30 seconds to allow any pending
 * publish operations or message consumptions to complete.
 *
 * Options:
 * * connectionString
 * * username
 * * password
 * * hostname
 * * recycleInterval (ms; default 1h)
 * * retirementDelay (ms; default 30s)
 * * minReconnectionInterval (ms; default 15s)
 * * monitor (taskcluster-lib-monitor instance)
 *
 * The pulse namespace for this user is available as `client.namespace`.
 */
class Client extends events.EventEmitter {
  constructor({username, password, hostname, connectionString, recycleInterval,
    retirementDelay, minReconnectionInterval, monitor}) {
    super();

    if (connectionString) {
      assert(!username, 'Can\'t use `username` along with `connectionString`');
      assert(!password, 'Can\'t use `password` along with `connectionString`');
      assert(!hostname, 'Can\'t use `hostname` along with `connectionString`');
      this.connectionString = connectionString;

      // extract the username as namespace
      const connURL = new URL(connectionString);
      this.namespace = decodeURI(connURL.username);
    } else {
      this.connectionString = buildConnectionString({username, password, hostname});
      this.namespace = username;
    }

    assert(monitor, 'monitor is required');
    this.monitor = monitor;

    this._recycleInterval = recycleInterval || 3600 * 1000;
    this._retirementDelay = retirementDelay || 30 * 1000;
    this._minReconnectionInterval = minReconnectionInterval || 15 * 1000;
    this.running = false;
    this.connections = [];
    this.connectionCounter = 0;
    this.lastConnectionTime = 0;

    this.id = ++clientCounter;
    this.debug = debug(`taskcluster-lib-pulse:client:${this.id}`);

    this.debug('starting');
    this.running = true;
    this.recycle();

    this._interval = setInterval(
      () => this.recycle(),
      this._recycleInterval);
  }

  async stop() {
    assert(this.running, 'Not running');
    this.debug('stopping');
    this.running = false;

    clearInterval(this._interval);
    this._interval = null;

    this.recycle();

    // wait until all existing connections are finished
    const unfinished = this.connections.filter(conn => conn.state !== 'finished');
    if (unfinished.length > 0) {
      await Promise.all(unfinished.map(
        conn => new Promise(resolve => { conn.once('finished', resolve); })));
    }
  }

  /**
   * Create a new connection, retiring any existing connection.
   */
  recycle() {
    this.debug('recycling');

    if (this.connections.length) {
      const currentConn = this.connections[0];
      currentConn.retire();
    }

    if (this.running) {
      const newConn = new Connection(this, ++this.connectionCounter);

      // don't actually start connecting until at least minReconnectionInterval has passed
      const earliestConnectionTime = this.lastConnectionTime + this._minReconnectionInterval;
      const now = new Date().getTime();
      setTimeout(() => {
        this.lastConnectionTime = new Date().getTime();
        newConn.connect();
      }, now < earliestConnectionTime ? earliestConnectionTime - now : 0);

      newConn.once('connected', () => {
        this.emit('connected', newConn);
      });
      newConn.once('finished', () => {
        this.connections = this.connections.filter(conn => conn !== newConn);
      });
      this.connections.unshift(newConn);
    }
  }

  /**
   * Get a full object name, following the Pulse security model,
   * `<kind>/<namespace>/<name>`.  This is useful for manipulating these objects
   * directly, for example to modify the bindings of an active queue.
   */
  fullObjectName(kind, name) {
    return `${kind}/${this.namespace}/${name}`;
  }

  /**
   * The active connection, if any.  This is useful when starting to use an already-
   * running client:
   *   client.on('connected', setupConnection);
   *   if (client.activeConnection) {
   *     await setupConnection(client.activeConnection);
   *   }
   */
  get activeConnection() {
    if (this.running && this.connections.length && this.connections[0].state === 'connected') {
      return this.connections[0];
    }
  }

  /**
   * Run the given async function with a connection.  This is similar to
   * client.once('connected', ..), except that it will fire immediately if
   * the client is already connected.  This does *not* automatically re-run
   * the function if the connection fails.
   */
  withConnection(fn) {
    if (this.activeConnection) {
      return fn(this.activeConnection);
    }

    return new Promise((resolve, reject) => {
      this.once('connected', conn => Promise.resolve(fn(conn)).then(resolve, reject));
    });
  }

  /**
   * Run the given async function with an amqplib channel or confirmChannel. This wraps
   * withConnection to handle closing the channel.
   */
  withChannel(fn, {confirmChannel} = {}) {
    return this.withConnection(async conn => {
      let flag = 0;
      const method = confirmChannel ? 'createConfirmChannel' : 'createChannel';
      const channel = await conn.amqp[method]().catch(e => {
        // indication of failure
        flag = 1; 
      });

      if (flag === 1) {
        return;
      }

      let returntype; // maybe useful for debugging
      try {
        returntype = await fn(channel);
      } finally {
        try {
          if (isNaN(returntype)) {
            channel.close();
          }
        } catch (err) {
          // an error trying to close the channel suggests the connection is dead
        }
      }
    });
  }
}

exports.Client = Client;

/**
 * A single connection to a pulse server.  This is a thin wrapper around a raw
 * AMQP connection, instrumented to inform the parent Client of failures
 * and trigger a reconnection.  It is possible to have multiple Connection
 * objects in the same process at the same time, while one is being "retired" but
 * is lingering around to send ack's for any in-flight message handlers.
 *
 * The instance's `amqp` property is the amqp connection object.  In the event of any
 * issues with the connection, call the instance's `failed` method.  This will initiate
 * a retirement of the connection and creation of a new connection.
 *
 * The instance will emit a `connected` event when it connects to the pulse server.
 * This event occurs before the connection is provided to a user, so it is only
 * of interest to the Client class.
 *
 * This instance will emit a `retiring` event just before it is retired.  Users
 * should cancel consuming from any channels, as a new connection will soon
 * begin consuming.  Errors from such cancellations should be logged and
 * ignored.  This connection will remain open for 30 seconds to allow any
 * in-flight message processing to complete.
 *
 * The instance will emit `finished` when the connection is finally closed.
 *
 * A connection's state can be one of
 *
 *  - waiting -- waiting for a call to connect() (for minReconnectionInterval)
 *  - connecting -- waiting for a connection to complete
 *  - connected -- connection is up and running
 *  - retiring -- in the process of retiring
 *  - finished -- no longer connected
 *
 *  Note that an instance that fails to connect will skip from `connecting` to
 *  `retiring`.
 *
 */
class Connection extends events.EventEmitter {
  constructor(client, id) {
    super();

    this.client = client;
    this.id = id;
    this.amqp = null;

    this.debug = debug(`taskcluster-lib-pulse:connection:${client.id}.${id}`);

    this.debug('waiting');
    this.state = 'waiting';
  }

  async connect() {
    if (this.state !== 'waiting') {
      return;
    }

    this.debug('connecting');
    this.state = 'connecting';
    try {
      const amqp = await amqplib.connect(this.client.connectionString, {
        heartbeat: 120,
        noDelay: true,
        timeout: 30 * 1000,
      });
      if (this.state !== 'connecting') {
        // we may have been retired already, in which case we do not need this
        // connection
        amqp.close();
        return;
      }
      this.amqp = amqp;
  
      amqp.on('error', err => {
        if (this.state === 'connected') {
          this.debug(`error from amqplib connection: ${err}`);
          this.failed();
        }
      });
  
      amqp.on('close', err => {
        if (this.state === 'connected') {
          this.debug('connection closed unexpectedly');
          this.failed();
        }
      });
      this.debug('connected');
      this.state = 'connected';
      this.emit('connected'); 
    } catch (err) {
      this.debug(`Error while connecting: ${err}`);
      this.failed();
    };
  }

  failed() {
    if (this.state === 'retired' || this.state === 'finished') {
      // failure doesn't matter at this point
      return;
    }
    this.debug('failed');
    this.client.recycle();
  }

  async retire() {
    if (this.state === 'retiring' || this.state === 'finished') {
      return;
    }

    this.debug('retiring');
    this.state = 'retiring';
    this.emit('retiring');

    // actually close this connection 30 seconds later
    await new Promise(resolve => setTimeout(resolve, this.client._retirementDelay));
    this.debug('finished; closing AMQP connection');
    try {
      await this.amqp.close();
    } catch (err) {
      // ignore..
    }
    this.amqp = null;
    this.state = 'finished';
    this.emit('finished');
  }
}
