const {Client, consume} = require('../src');
const amqplib = require('amqplib');
const assume = require('assume');
const debugModule = require('debug');
const libMonitor = require('taskcluster-lib-monitor');

const PULSE_CONNECTION_STRING = process.env.PULSE_CONNECTION_STRING;

suite('PulseQueue', function() {
  // use a unique name for each test run, just to ensure nothing interferes
  const unique = new Date().getTime().toString();
  const exchangeName = `exchanges/test/${unique}`;
  const routingKey = 'greetings.earthling.foo.bar.bing';
  const routingKeyReference = [
    {name: 'verb'},
    {name: 'object'},
    {name: 'remainder', multipleWords: true},
  ];
  const debug = debugModule('test');

  suiteSetup(async function() {
    if (!PULSE_CONNECTION_STRING) {
      this.skip();
      return;
    }

    // otherwise, set up the exchange
    const conn = await amqplib.connect(PULSE_CONNECTION_STRING);
    const chan = await conn.createChannel();
    await chan.assertExchange(exchangeName, 'topic');
    await chan.close();
    await conn.close();
  });

  const publishMessages = async () => {
    const conn = await amqplib.connect(PULSE_CONNECTION_STRING);
    const chan = await conn.createChannel();

    for (let i = 0; i < 10; i++) {
      const message = new Buffer(JSON.stringify({data: 'Hello', i}));
      debug(`publishing fake message ${i} to exchange ${exchangeName}`);
      await chan.publish(exchangeName, routingKey, message);
    }

    await chan.close();
    await conn.close();
  };

  test('consume messages', async function() {
    const monitor = await libMonitor({project: 'tests', mock: true});
    const client = new Client({
      connectionString: PULSE_CONNECTION_STRING,
      retirementDelay: 50,
      minReconnectionInterval: 20,
      monitor,
    });
    const got = [];

    await new Promise(async (resolve, reject) => {
      try {
        const pq = await consume({
          client,
          queueName: unique,
          bindings: [{
            exchange: exchangeName,
            routingKeyPattern: '#',
            routingKeyReference,
          }],
          prefetch: 2,
          handleMessage: async message => {
            debug(`handling message ${message.payload.i}`);
            // message three gets retried once and then discarded.
            if (message.payload.i == 3) {
              // inject an error to test retrying
              throw new Error('uhoh');
            }

            // recycle the client after we've had a few messages, just for exercise.
            // Note that we continue to process this message here
            if (got.length == 4) {
              client.recycle();
            }
            got.push(message);
            if (got.length === 9) {
              // stop the PulseQueue first, to exercise that code
              // (this isn't how pq.stop would normally be called!)
              pq.stop().then(resolve, reject);
            }
          },
        });

        // queue is bound by now, so it's safe to send messages
        await publishMessages();
      } catch (err) {
        reject(err);
      }
    });

    await client.stop();

    got.forEach(msg => {
      assume(msg.payload.data).to.deeply.equal('Hello');
      assume(msg.exchange).to.equal(exchangeName);
      assume(msg.routingKey).to.equal(routingKey);
      assume(msg.routing).to.deeply.equal({
        verb: 'greetings',
        object: 'earthling',
        remainder: 'foo.bar.bing',
      });
      // note that we ignore redelivered: some of these may be redelivered
      // when the connection is recycled..
      assume(msg.routes).to.deeply.equal([]);
    });

    const numbers = got.map(msg => msg.payload.i);
    numbers.sort(); // with prefetch, order is not guaranteed
    assume(numbers).to.deeply.equal([0, 1, 2, 4, 5, 6, 7, 8, 9]);
  });

  test('no queueuName without exclusiveQueue is an error', async function() {
    const monitor = await libMonitor({project: 'tests', mock: true});
    const client = new Client({
      connectionString: PULSE_CONNECTION_STRING,
      retirementDelay: 50,
      minReconnectionInterval: 20,
      monitor,
    });

    try {
      await consume({client, bindings: [], handleMessage: () => {}});
    } catch (err) {
      assume(err).to.match(/Must pass a queueName or exclusiveQueue/);
      await client.stop();
      return;
    }
    assert(false, 'Did not get expected error');

  });

  test('exclusive PulseQueue emits error on reconnect', async function() {
    const monitor = await libMonitor({project: 'tests', mock: true});
    const client = new Client({
      connectionString: PULSE_CONNECTION_STRING,
      retirementDelay: 50,
      minReconnectionInterval: 20,
      monitor,
    });
    const pq = await consume({
      client,
      bindings: [{
        exchange: exchangeName,
        routingKeyPattern: '#',
        routingKeyReference,
      }],
      exclusiveQueue: true,
      handleMessage: () => client.recycle(),
    });

    let gotError = new Promise((resolve, reject) => {
      pq.on('error', err => {
        try {
          assume(err.code).to.equal('ExclusiveQueueDisconneted');
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });

    await publishMessages();
    await gotError;
    await client.stop();
  });
});
