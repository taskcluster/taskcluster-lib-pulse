const assert = require('assert');
const taskcluster = require('taskcluster-client');

/**
 * Build Pulse ConnectionString, from options on the form:
 * {
 *   username:          // Pulse username
 *   password:          // Pulse password
 *   hostname:          // Hostname to use
 * }
 */
const pulseCredentials = ({username, password, hostname, vhost}) => {
  assert(username, 'options.username is required');
  assert(password, 'options.password is required');
  assert(hostname, 'options.hostname is required');
  assert(vhost, 'options.vhost is required');
  
  // Construct connection string
  return async () => {
    return {
      connectionString: [
        'amqps://',         // Ensure that we're using SSL
        encodeURI(username),
        ':',
        encodeURI(password),
        '@',
        hostname,
        ':',
        5671,                // Port for SSL
        '/',
        encodeURIComponent(vhost),
      ].join(''),
    };
  };
};

exports.pulseCredentials = pulseCredentials;

const connectionStringCredentials = (connectionString) => {
  return async () => {
    return {connectionString};
  };
};

exports.connectionStringCredentials = connectionStringCredentials;

/**
   * Get pulse credentials using taskcluster credentials and build connection string 
   * using taskcluster pulse service
*/
const claimedCredentials = ({rootUrl, credentials, namespace, expires, contact}) => {
  assert(rootUrl, 'rootUrl is required');
  assert(credentials, 'credentials is required');
  assert(namespace, 'namespace is required');

  const pulse = taskcluster.Pulse({
    credentials,
    rootUrl,
  });

  return async () => {
    const res = await pulse.claimNamespace(namespace, {
      expires,
      contact,
    });
    const connectionString = res.connectionString;
    const recycleAfter = res.reclaimAt - taskcluster.fromNow('0 minutes');
    return {connectionString, recycleAfter};
  };
};

exports.claimedCredentials = claimedCredentials;

const mockclaimedCredentials = (connectionString, recycleAfter) => {
  recycleAfter = recycleAfter || 10;

  return async () => {
    return {connectionString, recycleAfter};
  };
};

exports.mockclaimedCredentials = mockclaimedCredentials;