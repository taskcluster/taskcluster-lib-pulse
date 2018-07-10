const {Client, FakeClient} = require('./client');
const {consume} = require('./consumer');
const {credentials} = require('./credentials');

module.exports = {
  Client,
  FakeClient,
  consume,
  credentials,
};
