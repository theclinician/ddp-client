import { once } from './utils.js';
import {
  DDPError,
  DDPCancel,
} from './errors.js';

class Method {
  constructor({
    name,
    params,
    noRetry,
    asyncCallback,
    onResultReceived,
    cb,
  }) {
    this.name = name;
    this.params = params;
    this.noRetry = noRetry;
    this.asyncCallback = asyncCallback;
    this.onResultReceived = onResultReceived;
    this.dataVisible = false;
    this.methodResult = null;
    this.wasCanceled = false;

    this.setCallback(cb);
  }

  maybeInvokeCallback() {
    if (this.methodResult && this.dataVisible) {
      this.cb(...this.methodResult);
    }
  }

  result({ error, result }) {
    if (this.wasCanceled) {
      return;
    }
    if (this.methodResult) {
      console.warn('Methods should only receive result once');
      return;
    }
    this.methodResult = [
      error && new DDPError(error.error, error.reason, error.details),
      result,
    ];
    if (this.onResultReceived) {
      this.onResultReceived(...this.methodResult);
    }
    this.maybeInvokeCallback();
  }

  updated() {
    if (this.wasCanceled) {
      return;
    }
    if (this.dataVisible) {
      console.warn('Method received "updated" message twice');
      return;
    }
    this.dataVisible = true;
    this.maybeInvokeCallback();
  }

  cancel(err) {
    this.wasCanceled = true;
    this.cb(err || new DDPCancel());
  }

  setCallback(cb) {
    this.cb = once((...args) => {
      if (cb) {
        cb(...args);
      }
      if (this.asyncCallback) {
        this.asyncCallback(...args);
      }
    });
  }

  toDDPMessage(id) {
    const {
      name,
      params,
    } = this;
    return {
      id,
      params,
      method: name,
      msg: 'method',
    };
  }
}

export default Method;
