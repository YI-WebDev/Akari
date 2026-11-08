export class AkariError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'AkariError';
    this.code = code;
  }
}
