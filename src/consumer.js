const events = require('events');
const amqplib = require('amqplib');
const assert = require('assert');
const slugid = require('slugid');

/**
 * A PulseQueue declares a queue and listens for messages on that
 * queue, invoking a callback for each message.
 */
class PulseQueue extends events.EventEmitter {
  constructor({client, bindings, handleMessage, queueName, exclusiveQueue, ...options}) {
    super();

    this.client = client;
    this.bindings = bindings;
    this.handleMessage = handleMessage;
    this.options = {prefetch: 5, ...options};

    assert(queueName || exclusiveQueue, 'Must pass a queueName or exclusiveQueue');
    this.exclusiveQueue = exclusiveQueue;
    this.queueName = queueName;

    this._handleConnection = this._handleConnection.bind(this);

    // false once stop() has been called
    this.running = true;

    // the current channel and consumerTag, if any
    this.channel = null;
    this.consumerTag = null;

    // number of messages being processed right now, and a function to call
    // when that number goes to zero
    this.processingMessages = 0;
    this.idleCallback = null;
  }

  /**
   * Create and bind the queue, then start listening.  When this method has
   * returned, the queue is established and bound to the exchanges given in
   * the consumer.
   */
  async start() {
    // first make sure the queue is bound
    await this.client.withChannel(channel => this._createAndBindQueue(channel));

    // then set up to call _handleConnection on new connections and, if there
    // is already an active connection, on that as well.
    this.client.on('connected', this._handleConnection);
    if (this.client.activeConnection) {
      this._handleConnection(this.client.activeConnection);
    }
  }

  /**
   * Stop listening.  After this call, no further messages will be consumed
   * from the queue.  The queue and any bindings will remain configured on the
   * server.  This method will return after any pending consumers have
   * completed (ack or nack).
   */
  async stop() {
    if (!this.running) {
      return;
    }
    this.running = false;

    return this._shutdown();
  }

  /**
   * Shut down this listener and channel, without setting this.running to false
   */
  async _shutdown() {
    const {channel, consumerTag} = this;

    if (channel && consumerTag) {
      this.consumerTag = null;
      await channel.cancel(consumerTag);
    }

    // if messages are being processed, arrange to continue when they
    // are all handled
    if (this.processingMessages > 0) {
      await new Promise(resolved => {
        this.idleCallback = resolved;
      });
    }

    if (channel) {
      this.channel = null;
      await channel.close();
    }
  }

  async _createAndBindQueue(channel) {
    const queueName = this.client.fullObjectName(
      'queue',
      this.queueName || `exclusive/${slugid.v4()}`);
    await channel.assertQueue(queueName, {
      exclusive: this.exclusiveQueue,
      durable: !this.exclusiveQueue,
      autoDelete: this.exclusiveQueue,
      maxLength: this.options.maxLength,
    });

    for (let {exchange, routingKeyPattern} of this.bindings) {
      await channel.bindQueue(queueName, exchange, routingKeyPattern);
    }

    return queueName;
  }

  /**
   * Handle a new connection to the pulse server, re-declaring everything
   * and setting up the consumer.
   */
  async _handleConnection(conn) {
    try {
      if (!this.running) {
        return;
      }

      const amqp = conn.amqp;
      const channel = await amqp.createChannel();
      await channel.prefetch(this.options.prefetch);
      const queueName = await await this._createAndBindQueue(channel);
      this.channel = channel;

      // consider any errors on the channel to be potentially fatal to the
      // connection (better safe than sorry)
      channel.on('error', () => conn.failed());

      const consumer = await channel.consume(queueName, async (msg) => {
        try {
          this.processingMessages++;
          try {
            await this._handleMessage(msg);
          } catch (err) {
            if (msg.fields.redelivered) {
              // if this was already delivered, we're going to give up and report it
              channel.nack(msg, false, false);
              this.client.monitor.reportError(err, {
                queueName,
                exchange: msg.exchange,
                redelivered: msg.redelivered,
              });
            } else {
              channel.nack(msg, false, true);
            }
            return;
          }
          channel.ack(msg);
        } catch (err) {
          // the error handling in the inner try block went badly, so this
          // channel is probably sick
          this.client.monitor.reportError(err, {
            queueName,
            exchange: msg.exchange,
          });
          conn.failed();
        } finally {
          this.processingMessages--;
          if (this.processingMessages === 0 && this.idleCallback) {
            this.idleCallback();
          }
        }
      });
      this.consumerTag = consumer.consumerTag;

      // when retirement of this connection begins, stop consuming on this
      // channel and close the channel as soon sa all messages are handled.
      conn.on('retiring', () => this._shutdown());

      // ..and if the queue is exclusive, emit an error when we retire and the
      // connection is still running
      if (this.exclusiveQueue) {
        conn.on('retiring', () => {
          if (this.client.running) {
            const err = new Error('Exclusive queue disconnected; messages may be lost!');
            err.code = 'ExclusiveQueueDisconneted';
            this.emit('error', err);
          }
        });
      }
    } catch (err) {
      this.client.monitor.reportError(err);
      conn.failed();
    }
  }

  async _handleMessage(msg) {
    // Construct message
    let message = {
      payload:      JSON.parse(msg.content.toString('utf8')),
      exchange:     msg.fields.exchange,
      routingKey:   msg.fields.routingKey,
      redelivered:  msg.fields.redelivered,
      routes:       [],
    };

    // Find CC'ed routes
    if (msg.properties && msg.properties.headers &&
        msg.properties.headers.CC instanceof Array) {
      message.routes = msg.properties.headers.CC.filter(function(route) {
        // Only return the CC'ed routes that starts with "route."
        return /^route\.(.*)$/.test(route);
      }).map(function(route) {
        // Remove the "route."
        return /^route\.(.*)$/.exec(route)[1];
      });
    }

    // Find routing key reference for this exchange, if any is available to us
    let routingKeyReference = null;
    this.bindings.forEach(binding => {
      if (binding.exchange === message.exchange && binding.routingKeyReference) {
        routingKeyReference = binding.routingKeyReference;
      }
    });

    // If we have a routing key reference we can parse the routing key
    if (routingKeyReference) {
      let i, j;
      let routing = {};
      let keys = message.routingKey.split('.');
      // first handle non-multi keys from the beginning
      for (i = 0; i < routingKeyReference.length; i++) {
        let ref = routingKeyReference[i];
        if (ref.multipleWords) {
          break;
        }
        routing[ref.name] = keys.shift();
      }
      // If we reached a multi key
      if (i < routingKeyReference.length) {
        // then handle non-multi keys from the end
        for (j = routingKeyReference.length - 1; j > i; j--) {
          let ref = routingKeyReference[j];
          if (ref.multipleWords) {
            break;
          }
          routing[ref.name] = keys.pop();
        }
        // Check that we only have one multiWord routing key
        assert(i == j, 'i != j really shouldn\'t be the case');
        routing[routingKeyReference[i].name] = keys.join('.');
      }

      // Provide parsed routing key
      message.routing = routing;
    }

    await this.handleMessage(message);
  }
}

exports.PulseQueue = PulseQueue;

// TODO: unbindQueue static method
//  - listen to client for connections
//  - try to unbind with a connection
//  - resolve promise when done
