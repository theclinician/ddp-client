
class DDPError extends Error {
  constructor(error, reason, details) {
    super(reason);
    this.error = error;
    this.reason = reason;
    this.details = details;
  }
}

class DDPCancel extends Error {
  constructor() {
    super('DDP canceled');
    this.isCancel = true;
  }
}

export {
  DDPError,
  DDPCancel,
};
