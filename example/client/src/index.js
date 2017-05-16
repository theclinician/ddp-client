import DDPClient from 'ddp-client';
import React from 'react';
import ReactDOM from 'react-dom';
import App from './containers/App';
import Todo from './common/models/Todo';
import TodoList from './common/models/TodoList';
import './index.css';

const ddpClient = new DDPClient({
  endpoint: 'ws://localhost:4000/websocket',
  SocketConstructor: WebSocket,
  models: Object.assign({}, ...[
    Todo,
    TodoList,
  ].map(M => ({ [M.collection]: M }))),
});

ReactDOM.render(
  <App ddpClient={ddpClient}/>,
  document.getElementById('root')
);
