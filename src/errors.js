import DDPError from './DDPError';

class DDPCancel extends DDPError {
  constructor() {
    super('cancel', 'Action was canceled');
    this.isCancel = true;
  }
}

export {
  DDPError,
  DDPCancel,
};
