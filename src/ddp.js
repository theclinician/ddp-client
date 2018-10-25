import {
  EventEmitter,
} from '@theclinician/toolbelt';
import Socket from './socket';
import Method from './Method.js';
import Subscription from './Subscription.js';
import {
  once,
  omit,
  uniqueId,
} from './utils';
import {
  DDPError,
} from './errors.js';
import * as multiStorage from './multiStorage.js';

const DDP_VERSION = '1';
const DEFAULT_RECONNECT_INTERVAL = 10000;

interface AsyncStorage {
  get(string): Promise;
  set(string, mixed): Promise;
  del(string): Promise;
}

class DDP extends EventEmitter {
  status: string;
  subscriptions: { [string]: Subscription };
  methods: { [string]: Method };
  socket: Socket;
  collections: { [string]: { [string]: mixed } };
  models: { [string]: Function };
  storage: AsyncStorage;

  static registerModel(Model, collection) {
    if (!collection) {
      throw Error('Method registerModel() requires collection name as the second argument');
    }
    if (this.models[collection]) {
      console.error(`Overwriting model ${this.models[collection].name} bound to collection ${collection}; new model is ${Model.name}`);
    }
    this.models[Model.collection] = Model;
  }

  constructor(options: {
    debug?: boolean,
    endpoint: string,
    autoConnect?: boolean,
    autoReconnect?: boolean,
    reconnectInterval?: number,
    storage?: AsyncStorage,
  }) {
    super();

    this.captureUnhandledErrors([
      'error',
      'loginError',
      'resumeLoginError',
      'logoutError',
    ]);

    this.status = 'disconnected';
    this.endpoint = options.endpoint;

    // Default `autoConnect` and `autoReconnect` to true
    this.autoConnect = (options.autoConnect !== false);
    this.autoReconnect = (options.autoReconnect !== false);
    this.reconnectInterval = options.reconnectInterval || DEFAULT_RECONNECT_INTERVAL;
    this.collections = {};
    this.storage = options.storage || multiStorage;

    // Methods/ subscriptions handlers
    this.subscriptions = {};
    this.methods = {};
    this.handleLogoutFailure = options.handleLogoutFailure || this.constructor.defaultHandleLogoutFailure;

    this.methodsInQueue = [];
    this.methodsPending = {};
    this.currentMethodId = null;

    // Socket
    this.socket = new Socket(options.SocketConstructor, options.endpoint);

    if (options.debug) {
      this.socket.on('message:out', message => console.warn('DDP/OUT', message));
      this.socket.on('message:in', message => console.warn('DDP/IN', message));
    }

    this.socket.on('open', () => {
      // When the socket opens, send the `connect` message
      // to establish the DDP connection
      this.socket.send({
        msg: 'connect',
        version: DDP_VERSION,
        support: [DDP_VERSION],
      });
    });

    this.socket.on('close', () => {
      this.status = 'disconnected';

      this.emit('disconnected');
      if (this.autoReconnect) {
        // Schedule a connection
        setTimeout(
          this.socket.open.bind(this.socket),
          this.reconnectInterval,
        );
      }
    });

    this.socket.on('message:in', (message) => {
      switch (message.msg) {
        case 'connected':
          this.status = 'connected';
          // It's important to call it before resumeLogin because
          // when login returns it calls "emptyQueue" immediately.
          this.discardCancalableMethods();

          // NOTE: Restore subscriptions ensures that all subscriptiosn
          //       that were active before we lost the connection are now
          //       re-created. However, there might be elements that are outomatically published
          //       by meteor with Meteor.publish(null), e.g. current user details.
          //       To ensure they're not lost, instead of clearing cache inside restoreSubscriptions()
          //       we do it right here, immediatelly after receiving "connected" message.
          this.collections = {};

          this.resumeLogin().then(() => {
            // NOTE: Here we call again methods that were
            //       already called before. Theoretically it might be better
            //       to re-queue them instead of calling immediately, but it's
            //       not obvious what the logic should exactly be.
            this.restorePendingMethods();
            this.emptyQueue();
            this.restoreSubscriptions();
            this.emit('connected');
          });
          break;
        case 'ping':
          // Reply with a `pong` message to prevent the server from
          // closing the connection
          this.socket.send({ msg: 'pong', id: message.id });
          break;
        case 'ready':
          this.emit('ready', { subs: message.subs });
          message.subs.forEach(id => this.subscriptions[id] && this.subscriptions[id].ready());
          break;
        case 'nosub':
          if (this.subscriptions[message.id]) {
            this.subscriptions[message.id].nosub(message.error);
          }
          break;
        case 'result':
          if (this.methods[message.id]) {
            const { error, result } = message;
            this.methods[message.id].result({
              error,
              result,
            });
          }
          break;
        case 'updated':
          this.emit('updated', { methods: message.methods });
          message.methods.forEach(id => this.methods[id] && this.methods[id].updated());
          break;
        case 'error':
          this.emit('error', new DDPError('DDPError', message.reason));
          break;
        case 'added':
        case 'changed':
        case 'removed':
          this[message.msg](message);
          break;
        default:
          // ignore the message ...
      }
    });

    if (this.autoConnect) {
      this.connect();
    }
  }

  connect() {
    this.socket.open();
  }

  added({ collection, id, fields }) {
    const transform = this.constructor.defaultGetTransform(collection);
    if (transform) {
      this.collections = {
        ...this.collections,
        [collection]: {
          ...this.collections[collection],
          [id]: transform({
            _id: id,
            ...fields,
          }),
        },
      };
      this.emit('dataUpdated', this.collections);
    }
    this.emit('added', { collection, id, fields });
  }

  changed({ collection, id, fields, cleared }) {
    const transform = this.constructor.defaultGetTransform(collection);
    if (transform) {
      this.collections = {
        ...this.collections,
        [collection]: {
          ...this.collections[collection],
          [id]: transform(omit({
            // NOTE: Theoretically this should not happen, i.e. there
            //       should always be "added" prior to "changed", but
            //       sometimes it does not seem to be the case, so better
            //       fallback by interpreting the first "changed" as "added".
            _id: id,
            ...this.collections[collection] &&
               this.collections[collection][id],
            ...fields,
          }, cleared)),
        },
      };
      this.emit('dataUpdated', this.collections);
    }
    this.emit('changed', { collection, id, fields });
  }

  removed({ collection, id }) {
    const transform = this.constructor.defaultGetTransform(collection);
    if (transform) {
      this.collections = {
        ...this.collections,
        [collection]: this.collections[collection]
          ? omit(this.collections[collection], [id])
          : {},
      };
      this.emit('dataUpdated', this.collections);
    }
    this.emit('removed', { collection, id });
  }

  disconnect() {
    /**
     * If `disconnect` is called, the caller likely doesn't want the
     * the instance to try to auto-reconnect. Therefore we set the
     * `autoReconnect` flag to false.
     */
    this.autoReconnect = false;
    this.socket.close();
  }

  discardCancalableMethods() {
    Object.keys(this.methodsPending).forEach((id) => {
      const method = this.methods[id];
      if (method &&
          method.noRetry) {
        method.cancel();
      }
    });

    const methodsInQueue = [];
    this.methodsInQueue.forEach((queued) => {
      if (queued.cancelOnReconnect) {
        const method = this.methods[queued.id];
        if (method) {
          method.cancel();
          delete this.methods[queued.id];
        }
      } else {
        methodsInQueue.push(queued);
      }
    });
    this.methodsInQueue = methodsInQueue;
  }

  emptyQueue() {
    if (this.currentMethodId || this.status !== 'connected') {
      return;
    }
    while (this.methodsInQueue.length > 0) {
      const { id, wait } = this.methodsInQueue.shift();
      const method = this.methods[id];
      if (method) {
        if (method.wasCanceled) {
          delete this.methods[id];
        } else {
          this.socket.send(method.toDDPMessage(id));
          this.methodsPending[id] = method;
          method.setCallback(() => {
            delete this.methods[id];
            delete this.methodsPending[id];
            if (wait) {
              this.currentMethodId = null;
              this.emptyQueue();
            }
          });
          if (wait) {
            this.currentMethodId = id;
            return;
          }
        }
      }
    }
  }

  restorePendingMethods() {
    const allMethodsIds = Object.keys(this.methodsPending);
    allMethodsIds.forEach((id) => {
      const method = this.methods[id];
      if (method &&
          !method.wasCanceled &&
          !method.methodResult) {
        this.socket.send(method.toDDPMessage(id));
      }
    });
    this.once('restored', () => {
      allMethodsIds.forEach((id) => {
        const method = this.methods[id];
        if (method &&
            method.methodResult &&
            !method.wasCanceled &&
            !method.dataVisible) {
          method.updated();
        }
      });
    });
  }

  restoreSubscriptions() {
    let numberOfPending = Object.keys(this.subscriptions).length;

    const cb = () => {
      numberOfPending -= 1;
      if (numberOfPending === 0) {
        this.emit('restored');
      }
    };

    if (numberOfPending > 0 && this.status === 'connected') {
      this.emit('restoring');
      Object.keys(this.subscriptions).forEach((id) => {
        this.subscriptions[id].setCallback(cb);
        this.socket.send(this.subscriptions[id].toDDPMessage(id));
      });
    }
  }

  subscribe(name, params, { onStop, onReady } = {}) {
    const id = uniqueId();

    this.subscriptions[id] = new Subscription({
      name,
      params,
      onStop,
      onReady,
    });

    if (this.status === 'connected') {
      this.socket.send(this.subscriptions[id].toDDPMessage(id));
    }

    return {
      stop: once(() => {
        if (this.status === 'connected') {
          this.socket.send({ id, msg: 'unsub' });
        }
        delete this.subscriptions[id];
        if (onStop) {
          onStop();
        }
      }),
    };
  }

  apply(name, params, {
    wait,
    cancelOnReconnect,
    noRetry,
    skipQueue,
    onResultReceived,
    throwStubExceptions,
  } = {}, asyncCallback) {
    if (!asyncCallback) {
      return new Promise((resolve, reject) => {
        this.apply(name, params, {
          wait,
          cancelOnReconnect,
          noRetry,
          skipQueue,
          onResultReceived,
          throwStubExceptions,
        }, (error, result) => (error ? reject(error) : resolve(result)));
      });
    }

    const id = uniqueId();
    this.methods[id] = new Method({
      name,
      params,
      noRetry,
      onResultReceived,
      asyncCallback,
    });

    const queued = {
      id,
      wait,
      cancelOnReconnect,
    };
    if (skipQueue) {
      this.methodsInQueue.unshift(queued);
    } else {
      this.methodsInQueue.push(queued);
    }
    this.emptyQueue();

    return undefined;
  }

  handleLogin({ id, token }) {
    this.userId = id;
    return (token
            ? this.storage.set(`${this.endpoint}__login_token__`, token)
            : Promise.resolve()
          )
          .then(this.emit.bind(this, 'loggedIn', id))
          .then(() => id);
  }

  handleLogout() {
    this.userId = null;
    return this.storage
          .del(`${this.endpoint}__login_token__`)
          .then(this.emit.bind(this, 'loggedOut'))
          .then(() => null);
  }

  resumeLogin() {
    // NOTE: This promise never rejects
    return Promise.resolve()
          .then(this.emit.bind(this, 'loggingIn'))
          .then(() => this.storage.get(`${this.endpoint}__login_token__`))
          .then((resume) => {
            if (!resume) {
              // NOTE: It's important to emit loginError here, because we've already
              //       triggered loggingIn. So by triggering error as well we are
              //       indicating that the login procedure was actually terminated.
              this.emit('loginError', new Error('No login token'));
              return undefined;
            }
            return this.login({ resume }, { skipQueue: true });
          })
          .catch(err =>
            Promise.resolve()
              .then(this.handleLogout.bind(this))
              .then(this.emit.bind(this, 'resumeLoginError', err)),
          );
  }

  login(options, { skipQueue } = {}) {
    return this.executeLoginRoutine('login', [options], { skipQueue });
  }

  logout() {
    return Promise.resolve()
          .then(this.emit.bind(this, 'loggingIn'))
          .then(this.apply.bind(this, 'logout', []))
          .then(this.handleLogout.bind(this))
          .catch(err =>
            Promise.resolve()
              .then(this.handleLogoutFailure.bind(this, err))
              .then(this.emit.bind(this, 'logoutError', err))
              .then(() => Promise.reject(err)),
          );
  }

  executeLoginRoutine(name, params, { skipQueue = false } = {}) {
    let getLoginPromise;
    if (typeof name === 'function') {
      getLoginPromise = name;
    } else {
      getLoginPromise = () => this.apply(name, params, { skipQueue, wait: true });
    }
    return Promise.resolve()
          .then(this.emit.bind(this, 'loggingIn'))
          .then(() => getLoginPromise())
          .then(this.handleLogin.bind(this))
          .catch(err =>
            Promise.resolve()
              .then(this.emit.bind(this, 'loginError', err))
              .then(this.handleLogout.bind(this))
              .then(() => Promise.reject(err)),
          );
  }
}

const identity = x => x;

DDP.models = {};
DDP.defaultGetTransform = (collection) => {
  const Model = DDP.models[collection];
  if (Model) {
    return doc => new Model(doc);
  }
  return identity;
};

DDP.defaultHandleLogoutFailure = function () {
  this.handleLogout();
};

export default DDP;
