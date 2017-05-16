
class ValidationError extends Error {
  constructor(errors, reason) {
    super(reason);
    this.error = 'ValidationError';
    this.reason = reason;
    this.details = errors;
  }
}

export const callMethod = (apiSpec, params) => (dispatch, getState, { ddpClient }) =>
  apiSpec.callMethod(params, { client: ddpClient, ValidationError });
