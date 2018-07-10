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
    {
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
      ].join('');
    }
  };
};

const connectionStringCredentials = (connectionString) => {
  return async () => {
    return {connectionString};
  };
};

/**
   * Get pulse credentials using taskcluster credentials and build connection string 
   * using taskcluster pulse service
*/
const claimedCredentials = ({rootUrl, credentials, namespace, expires, contact}) => {
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

exports = {
  pulseCredentials,
  connectionStringCredentials,
  claimedCredentials,
};