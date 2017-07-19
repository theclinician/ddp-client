import React from 'react';
import PropTypes from 'prop-types';
import DDPClient from 'ddp-client';
import {
  isEqual,
  compact,
} from 'lodash';
import {
  debounce,
} from '@theclinician/toolbelt';

const increase = (key, value) => (prevState) => ({
  ...prevState,
  [key]: (prevState[key] || 0) + value,
});

const setupListeners = (ddpClient, cb) => {
  let listeners = [];
  let updatePending = false;
  let afterFlushListeners = [];

  const scheduleFlush = debounce(() => {
    if (!listeners) {
      return;
    }
    cb(ddpClient.collections);
    for (const action of afterFlushListeners) {
      action();
    }
    afterFlushListeners = [];
    updatePending = false;
  }, {
    ms: 100,
  });

  listeners.push(ddpClient.on('dataUpdated', () => {
    updatePending = true;
    scheduleFlush();
  }));
  cb(ddpClient.collections);

  return {
    stop() {
      if (listeners) {
        listeners.forEach(stop => stop());
      }
      listeners = null;
    },
    afterFlush(action) {
      if (updatePending) {
        afterFlushListeners.push(action);
      } else {
        action();
      }
    },
  }
};

const ddp = ({
  subscriptions,
  mutations = {},
}, {
  onMutationError,
  renderLoader,
} = {}) => (Inner) => {
  const propTypes = {
    subscriptions: PropTypes.array,
    subscriptionsReady: PropTypes.bool,
  };

  const defaultProps = {
    subscriptions: [],
    subscriptionsReady: true,
  };

  const contextTypes = {
    ddpClient: PropTypes.instanceOf(DDPClient).isRequired,
  };

  class Container extends React.Component {
    constructor(props) {
      super(props);
      this.state = {
        collections: {},
        numberOfPendingMutations: 0,
        numberOfPendingSubscriptions: compact(subscriptions(props)).length,
      };
      const mutate = (request) => {
        if (request) {
          const { name, params } = request;
          this.beginMutation();
          return this.ddpClient.apply(name, params, {})
            .then((res) => {
              this.endMutation();
              return res;
            })
            .catch((err) => {
              this.endMutation();
              if (onMutationError) {
                onMutationError(err);
              } else {
                throw err;
              }
            });
        }
        return Promise.resolve();
      };

      this.handlers = {};
      Object.keys(mutations).forEach((key) => {
        this.handlers[key] = (...args) => {
          mutations[key]({
            ...this.props,
            mutate,
          })(...args);
        };
      });
    }

    componentWillMount() {
      const ddpClient = this.context.ddpClient;
      this.listeners = setupListeners(ddpClient, (collections) => {
        this.setState({ collections });
      });
      this.ddpClient = ddpClient;
      this.currentSubs = [];
      this.subscriptions = [];
    }

    componentDidMount() {
      this.updateSubscriptions();
    }

    componentWillReceiveProps(newProps) {
      this.updateSubscriptions(newProps);
    }

    componentWillUnmount() {
      if (this.listeners) {
        this.listeners.stop();
        this.listeners = null;
      }
      this.currentSubs.forEach(sub => sub.handle.stop());
      this.currentSubs = [];
    }

    updateSubscriptions(newProps = this.props) {
      const keep = new Map();
      const newSubs = [];
      if (!this.wasUpdated) {
        this.setState({
          numberOfPendingSubscriptions: 0,
        });
      }
      subscriptions(newProps).forEach((options) => {
        const sub = this.currentSubs.find(s => isEqual(s.options, options));
        if (sub) {
          keep.set(sub, true);
        } else {
          this.beginSubscription();
          newSubs.push({
            options,
            handle: this.ddpClient.subscribe(options.name, options.params, {
              onReady: () => this.listeners.afterFlush(() => this.endSubscription()),
            }),
          });
        }
      });
      this.currentSubs.forEach((sub) => {
        if (keep.has(sub)) {
          newSubs.push(sub);
        } else {
          sub.handle.stop();
        }
      });
      this.currentSubs = newSubs;
      this.wasUpdated = true;
    }

    beginSubscription() {
      this.setState(increase('numberOfPendingSubscriptions', 1));
    }

    endSubscription() {
      this.setState(increase('numberOfPendingSubscriptions', -1));
    }

    beginMutation() {
      this.setState(increase('numberOfPendingMutations', 1));
    }

    endMutation() {
      this.setState(increase('numberOfPendingMutations', -1));
    }

    render() {
      const {
        collections,
        numberOfPendingMutations,
        numberOfPendingSubscriptions,
      } = this.state;
      const {
        queries,
        subscriptions,
        ...other
      } = this.props;
      const mutationsReady = numberOfPendingMutations <= 0;
      const subscriptionsReady = numberOfPendingSubscriptions <= 0;
      if (renderLoader && !subscriptionsReady) {
        return renderLoader({
          ...other,
          subscriptionsReady,
          mutationsReady,
          collections,
        });
      }
      return React.createElement(Inner, {
        ...other,
        ...this.handlers,
        collections,
        mutationsReady,
        subscriptionsReady,
      });
    }
  }

  Container.propTypes = propTypes;
  Container.defaultProps = defaultProps;
  Container.contextTypes = contextTypes;

  if (process.env.NODE_ENV !== 'production') {
    Container.displayName = `ddp(${Inner.displayName})`;
  }

  return Container;
};

export default ddp;
