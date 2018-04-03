import DDPError from './DDPError';

class DDPCancel extends DDPError {
  constructor(message = 'Action was canceled') {
    super('cancel', message);
    this.isCancel = true;
  }
}

export {
  DDPError,
  DDPCancel,
};
