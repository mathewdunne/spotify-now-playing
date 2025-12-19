export class AuthenticationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AuthenticationError';
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
