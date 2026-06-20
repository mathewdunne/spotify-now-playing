export class AuthenticationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AuthenticationError';
	}
}

// Thrown when Spotify rejects the refresh token (invalid_grant). The refresh token has
// expired (6-month lifetime) and the user must re-authenticate via /login. Extends
// AuthenticationError so it still maps to a 401 in the main handler.
export class ReauthRequiredError extends AuthenticationError {
	constructor(message: string) {
		super(message);
		this.name = 'ReauthRequiredError';
	}
}

export class SpotifyApiError extends Error {
	constructor(
		message: string,
		public statusCode: number
	) {
		super(message);
		this.name = 'SpotifyApiError';
	}
}
