import { once } from './utils.js';
import {
  DDPError,
} from './errors.js';

class Subscription {
  constructor({
    name,
    params,
    onReady,
    onStop,
  }) {
    this.name = name;
    this.params = params || [];
    this.onReady = once(onReady);
    this.onStop = once(onStop);
    this.wasCanceled = false;
  }

  ready() {
    if (this.wasCanceled) {
      return;
    }
    this.onReady();
    if (this.cb) {
      this.cb();
    }
  }

  nosub(error) {
    if (this.wasCanceled) {
      return;
    }
    const err = error && new DDPError(error.error, error.reason, error.details);
    this.onStop(err);
    if (this.cb) {
      this.cb(err);
    }
  }

  cancel() {
    this.wasCanceled = true;
    this.onStop();
  }

  setCallback(cb) {
    this.cb = once(cb);
  }

  toDDPMessage(id) {
    const {
      name,
      params,
    } = this;
    return {
      id,
      name,
      params,
      msg: 'sub',
    };
  }
}

export default Subscription;
