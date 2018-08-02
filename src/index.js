const {client, FakeClient} = require('./client');
const {consume} = require('./consumer');
const {
  pulseCredentials,
  connectionStringCredentials,
  claimedCredentials,
  mockclaimedCredentials,
} = require('./credentials');
const {Exchanges} = require('./publisher');

module.exports = {
  client,
  FakeClient,
  consume,
  pulseCredentials,
  connectionStringCredentials,
  claimedCredentials,
  mockclaimedCredentials,
  Exchanges,
};