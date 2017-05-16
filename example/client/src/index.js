import DDPClient from '@theclinician/ddp-client';
import React from 'react';
import ReactDOM from 'react-dom';
import App from './containers/App';
import './index.css';

const ddpClient = new DDPClient({
  endpoint: 'ws://localhost:4000/websocket',
  SocketConstructor: WebSocket,
});

ReactDOM.render(
  <App ddpClient={ddpClient}/>,
  document.getElementById('root')
);
