/**
 * Friendly HTTP error messages for common status codes.
 * Used across the app to translate raw server errors into
 * human-readable descriptions.
 */

/** Friendly descriptions for HTTP status codes. */
const HTTP_STATUS_MESSAGES: Readonly<Record<number, { readonly title: string; readonly description: string }>> = {
  400: {
    title: 'Bad Request',
    description: 'The server could not understand the request. This usually means the query or filter syntax needs to be corrected.',
  },
  401: {
    title: 'Not Authorized',
    description: 'The server requires authentication. Check your credentials in the connection settings and try again.',
  },
  403: {
    title: 'Access Denied',
    description: 'You don\'t have permission to access this resource. Contact the data provider if you believe this is an error.',
  },
  404: {
    title: 'Not Found',
    description: 'The requested resource was not found on this server. It may have been removed or the URL may be incorrect.',
  },
  408: {
    title: 'Request Timeout',
    description: 'The server took too long to respond. Try again in a moment, or simplify your query.',
  },
  429: {
    title: 'Too Many Requests',
    description: 'You\'ve exceeded the rate limit for this server. Please wait a few minutes before trying again.',
  },
  500: {
    title: 'Server Error',
    description: 'The remote server encountered an internal error. This is a problem with the data provider, not with this application.',
  },
  502: {
    title: 'Bad Gateway',
    description: 'The server received an invalid response from an upstream service. Try again in a moment.',
  },
  503: {
    title: 'Service Unavailable',
    description: 'The server is temporarily unavailable. It may be undergoing maintenance. Try again later.',
  },
  504: {
    title: 'Gateway Timeout',
    description: 'The server did not respond in time. Try again in a moment, or simplify your query.',
  },
};

/** Extract an HTTP status code from an error message string (e.g., "Failed to fetch $metadata: 429"). */
const extractStatusCode = (message: string): number | undefined => {
  const match = message.match(/\b([1-5]\d{2})\b/);
  return match ? Number(match[1]) : undefined;
};

/**
 * Extract the actual target URL from a request URL, unpacking the proxy wrapper if present.
 * e.g., "/api/proxy?url=https%3A%2F%2Fapi.example.com%2FProperty" → "https://api.example.com/Property"
 */
export const unpackRequestUrl = (url: string): string => {
  try {
    const parsed = new URL(url, 'http://localhost');
    if (parsed.pathname === '/api/proxy') {
      const target = parsed.searchParams.get('url');
      if (target) return target;
    }
  } catch {
    // Try regex fallback for relative URLs
    const match = url.match(/\/api\/proxy\?url=([^&]+)/);
    if (match) {
      try { return decodeURIComponent(match[1]); } catch { /* fall through */ }
    }
  }
  return url;
};

/** Result of formatting an error for display. */
export interface FriendlyErrorInfo {
  /** Short title for the error (e.g., "Too Many Requests"). */
  readonly title: string;
  /** Human-readable description of what happened. */
  readonly description: string;
  /** The original server message, if different from the description. */
  readonly serverMessage?: string;
  /** HTTP status code, if detected. */
  readonly statusCode?: number;
  /** The request URL that caused the error (proxy unpacked). */
  readonly requestUrl?: string;
}

/**
 * Format a raw error into a friendly, user-readable form.
 * Detects HTTP status codes and provides clear explanations.
 */
export const formatError = (rawMessage: string, serverResponse?: string, requestUrl?: string): FriendlyErrorInfo => {
  const cleanUrl = requestUrl ? unpackRequestUrl(requestUrl) : undefined;
  const statusCode = extractStatusCode(rawMessage);

  if (statusCode) {
    const info = HTTP_STATUS_MESSAGES[statusCode];
    if (info) {
      return {
        title: info.title,
        description: info.description,
        serverMessage: serverResponse ?? (rawMessage.includes(':') ? rawMessage : undefined),
        statusCode,
        requestUrl: cleanUrl,
      };
    }

    // Known status code but no specific message
    const isServerError = statusCode >= 500;
    return {
      title: isServerError ? 'Server Error' : 'Request Failed',
      description: isServerError
        ? `The remote server returned error ${statusCode}. This is a problem with the data provider, not with this application.`
        : `The server returned error ${statusCode}.`,
      serverMessage: serverResponse ?? rawMessage,
      statusCode,
      requestUrl: cleanUrl,
    };
  }

  // No status code detected — check for common patterns
  if (/network|fetch|CORS|ERR_/i.test(rawMessage)) {
    return {
      title: 'Connection Error',
      description: 'Could not connect to the server. Check that the server URL is correct and that you have an internet connection.',
      serverMessage: rawMessage,
      requestUrl: cleanUrl,
    };
  }

  if (/timeout/i.test(rawMessage)) {
    return {
      title: 'Request Timeout',
      description: 'The server took too long to respond. Try again in a moment.',
      serverMessage: rawMessage,
      requestUrl: cleanUrl,
    };
  }

  return {
    title: 'Something Went Wrong',
    description: rawMessage,
    requestUrl: cleanUrl,
  };
};
