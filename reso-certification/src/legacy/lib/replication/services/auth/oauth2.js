'use strict';

const { NOT_OK } = require('../../../../common');

const USER_AGENT_HEADER = 'RESO Replication Client',
  DEFAULT_EXPIRATION_S = 15 * 60, // 15 minutes
  DEFAULT_EXPIRATION_DRIFT_S = 30;

// Returns true only if the given URL is well-formed and uses HTTPS
const isValidHttpsUrl = url => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

// Throws if the fetch response indicates a non-successful HTTP status
const _assertResponseOk = response => {
  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status} ${response.statusText}`);
  }
  return response;
};

// Returns a valid expiration duration in seconds, falling back to the default if the value is missing or non-positive
const _resolveExpiresIn = expiresIn =>
  !!expiresIn && parseInt(expiresIn) > 0 ? parseInt(expiresIn) : DEFAULT_EXPIRATION_S;

const _authInfo = {
  bearerToken: null,
  clientCredentials: {
    clientId: null,
    clientSecret: null,
    tokenUri: null,
    scope: null
  },
  tokenType: null,
  tokenExpirationDate: null
};

/**
 * Returns true if client credentials auth is configured (clientId, clientSecret, and tokenUri are all present)
 * @returns {boolean} true if client credentials are set, false otherwise
 */
const isClientCredentialsAuth = () =>
  !!(_authInfo?.clientCredentials?.clientId && _authInfo?.clientCredentials?.clientSecret && _authInfo?.clientCredentials?.tokenUri);

let _isInitialized = false;

/**
 * Accessor method for determining whether something is initialized
 * @returns true if initialized, false otherwise
 */
const getIsInitialized = () => !!_isInitialized;

/**
 *
 * Initializes singleton service
 *
 * @param {Object} credentials An object containing either a bearer token or client credentials
 */
const init = async ({ bearerToken, clientCredentials = {} }) => {
  
  try {
    if (bearerToken) {
      _authInfo.bearerToken = bearerToken;
      _isInitialized = true;
    } else if (clientCredentials && Object.values(clientCredentials)?.length) {
      //save for later in case we need to refresh the token
      _authInfo.clientCredentials = clientCredentials;

      await _fetchClientCredentialsAccessToken(clientCredentials);
      _isInitialized = true;
    } else {
      throw new Error('No supported auth credentials were provided! Please pass either bearerToken or clientCredentials.');
    }
  } catch (err) {
    throw new Error(err);
  }
};

/**
 * Fetches an OAuth2 access token using the client credentials grant flow and stores it in _authInfo.
 * Sets the bearer token, expiration date, token type, and scope from the response.
 * 
 * See: https://datatracker.ietf.org/doc/html/rfc6749#section-4.4.2
 *
 * @param {Object} options
 * @param {string} options.clientId OAuth2 client ID
 * @param {string} options.clientSecret OAuth2 client secret
 * @param {string} options.tokenUri Token endpoint URL
 * @param {string} [options.scope] Optional scope(s) to request
 * @param {boolean} [options.useBasicAuth=true] If true, sends credentials via HTTP Basic Auth header
 * @param {boolean} [options.useBody] Reserved for body-based auth (currently unsupported)
 */
const _fetchClientCredentialsAccessToken = async ({ clientId, clientSecret, tokenUri, scope, useBasicAuth = true, useBody } = {}) => {
  try {
    if (!isValidHttpsUrl(tokenUri)) {
      throw new Error(`tokenUri must be a valid HTTPS URL, got: ${tokenUri}`);
    }

    let headers = {},
      body;

    if (useBasicAuth) {
      headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'User-Agent': USER_AGENT_HEADER
      };

      const params = new URLSearchParams();
      params.append('grant_type', 'client_credentials');

      if (scope && scope?.length) {
        params.append('scope', scope);
      }

      body = params;
    } else if (useBody) {
      throw new Error('Unsupported auth option!');
    } else {
      throw new Error('Unsupported auth type!');
    }

    const response = await fetch(tokenUri, {
      method: 'POST',
      headers,
      body
    });

    _assertResponseOk(response);

    const { access_token, expires_in, token_type, scope: responseScope } = await response.json();

    _authInfo.bearerToken = access_token;
    _authInfo.expiresIn = _resolveExpiresIn(expires_in);
    _authInfo.tokenType = token_type;
    _authInfo.scope = responseScope;
    _authInfo.tokenExpirationDate = new Date(new Date().setSeconds(new Date().getSeconds() + _resolveExpiresIn(expires_in) - DEFAULT_EXPIRATION_DRIFT_S));
  } catch (err) {
    console.error(err.message);
    process.exit(NOT_OK);
  }
};

/**
 * Returns the current bearer token, and if the user is using client credentials
 * and the token has expired, the token will refresh
 * @returns a bearer token
 */
const getBearerToken = async () => {
  _checkIsInitialized();

  if (isClientCredentialsAuth()) {
    if (new Date() >= _authInfo.tokenExpirationDate) {
      await _fetchClientCredentialsAccessToken(_authInfo.clientCredentials);
    }
  }
  return _authInfo.bearerToken;
};

/**
 * Handles the case where the service hasn't been initialized before calling
 */
const _checkIsInitialized = () => {
  if (!getIsInitialized()) {
    throw new Error('The auth service MUST be initialized before it can be called. See init()!');
  }
};

/**
 * Creates a bearer token auth header, i.e. "Authorization: Bearer <token>"
 *
 * @param {String} token bearer token to be used for a given HTTP request
 * @returns a header constructed from the given token, or an empty object if the token is invalid
 */
const getOAuth2BearerTokenHeader = async () => {
  _checkIsInitialized();
  return { Authorization: `Bearer ${await getBearerToken()}` };
};

module.exports = {
  init,
  getBearerToken,
  getOAuth2BearerTokenHeader,
  getIsInitialized
};
