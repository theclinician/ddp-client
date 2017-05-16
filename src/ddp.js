import {
  EventEmitter,
  Queue,
} from '@theclinician/toolbelt';
import Socket from './socket';
import Method from './Method.js';
import Subscription from './Subscription.js';
import {
  once,
  uniqueId,
} from './utils';
import {
  DDPError,
} from './errors.js';
import * as multiStorage from './multiStorage.js';

const DDP_VERSION = '1';
const DEFAULT_RECONNECT_INTERVAL = 10000;

class DDP extends EventEmitter {
  status: string;
  subscriptions: { [string]: Subscription };
  methods: { [string]: Method };
  socket: Socket;
  methodsQueue: Queue;
  collections: { [string]: { [string]: mixed } };
  models: { [string]: Function };

  constructor(options: {
    debug?: boolean,
    endpoint: string,
    autoConnect?: boolean,
    autoReconnect?: boolean,
    reconnectInterval?: number,
    models?: { [string]: Function },
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
    this.models = options.models || {};

    Object.keys(this.models).forEach((name) => {
      this.collections[name] = {};
    });

    // Methods/ subscriptions handlers
    this.subscriptions = {};
    this.methods = {};

    this.methodsQueue = new Queue({
      onError: () => false, // make sure the queue is not terminated even if one error occurs
    });
    this.methodsQueue.pause();

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

      this.methodsQueue.pause();
      this.methodsQueue.clear();
      this.cancelPendingMethods(new Error('Connection was lost'));

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
          this.resumeLogin().then(() => {
            this.methodsQueue.resume();
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
    const Model = this.models[collection];
    if (Model) {
      this.collections = {
        ...this.collections,
        [collection]: {
          ...this.collections[collection],
          [id]: new Model({
            _id: id,
            ...fields,
          }),
        },
      };
    }
    this.emit('added', { collection, id, fields });
  }

  changed({ collection, id, fields }) {
    const Model = this.models[collection];
    if (Model) {
      this.collections = {
        ...this.collections,
        [collection]: {
          ...this.collections[collection],
          [id]: new Model({
            ...this.collections[collection][id],
            ...fields,
          }),
        },
      };
    }
    this.emit('changed', { collection, id, fields });
  }

  removed({ collection, id }) {
    const Model = this.models[collection];
    if (Model) {
      this.collections = {
        ...this.collections,
        [collection]: Object.assign({},
          ...Object.keys(this.collections[collection])
            .filter(key => key !== id)
            .map(key => ({ [key]: this.collections[collection] })),
        ),
      };
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

  cancelPendingMethods(err) {
    Object.keys(this.methods).forEach((id) => {
      this.methods[id].cancel(err);
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
    noRetry,
    skipQueue,
    onResultReceived,
    throwStubExceptions,
  } = {}, asyncCallback) {
    if (!asyncCallback) {
      return new Promise((resolve, reject) => {
        this.apply(name, params, {
          wait,
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

    const action = (cb) => {
      const method = this.methods[id];
      if (method) {
        this.methods[id].setCallback((error, result) => {
          if (cb) {
            cb(error, result);
          }
          delete this.methods[id];
        });
        if (this.status === 'connected') {
          this.socket.send(method.toDDPMessage(id));
        } else {
          // NOTE: Theoretically this should not happen since we are pausing
          //       queue when status in disconnected. Better safe than sorry.
          this.methods[id].cancel();
        }
      }
    };

    if (skipQueue) {
      action(null);
    } else {
      this.methodsQueue.push({
        noWait: !wait,
        onStop: (err) => {
          // This can be called when queue is clear, e.g. when connection is lost.
          if (this.methods[id]) {
            this.methods[id].cancel(err);
          }
        },
        action,
      });
    }

    return undefined;
  }

  handleLogin({ id, token }) {
    this.userId = id;
    return multiStorage
          .set(`${this.endpoint}__login_token__`, token)
          .then(this.emit.bind(this, 'loggedIn', id))
          .then(() => id);
  }

  handleLogout() {
    this.userId = null;
    return multiStorage
          .del(`${this.endpoint}__login_token__`)
          .then(this.emit.bind(this, 'loggedOut'))
          .then(() => null);
  }

  resumeLogin() {
    // NOTE: This promise never rejects
    return Promise.resolve()
          .then(this.emit.bind(this, 'loggingIn'))
          .then(() => multiStorage.get(`${this.endpoint}__login_token__`))
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
              .then(this.handleLogout.bind(this))
              .then(this.emit.bind(this, 'logoutError', err))
              .then(() => Promise.reject(err)),
          );
  }

  executeLoginRoutine(name, params, { skipQueue = false } = {}) {
    return Promise.resolve()
          .then(this.emit.bind(this, 'loggingIn'))
          .then(this.apply.bind(this, name, params, { skipQueue, wait: true }))
          .then(this.handleLogin.bind(this))
          .catch(err =>
            Promise.resolve()
              .then(this.emit.bind(this, 'loginError', err))
              .then(() => Promise.reject(err)),
          );
  }
}

export default DDP;
