import React from 'react';
import {
  values,
} from 'lodash';
import { Link } from 'react-router-dom';
import {
  compose,
  withState,
  withProps,
  mapProps,
  withHandlers,
} from 'recompose';
import {
  insert,
  update,
  // remove,
  todosInList,
} from '../common/api/Todos';
import {
  oneList,
} from '../common/api/TodoLists';
import ddp from '../common/utils/ddp';
import Todo from '../common/models/Todo.js';
import TodoList from '../common/models/TodoList.js';

const ListItem = withHandlers({
  onUpdate: ({
    todo,
    onUpdate,
  }) => () => onUpdate({
    todoId: todo._id,
    done: !todo.isDone(),
    name: todo.getName(),
  }),
})(({
  todo,
  onUpdate,
}) => (
  <li key={todo._id} onClick={onUpdate} style={{
    ...todo.isDone() && { textDecoration: 'line-through' },
  }}>
    {todo.name}
  </li>
));

const Lists = compose(
  withState('name', 'setName', ''),
  withProps(({ match: { params: { listId } } }) => ({
    listId
  })),
  ddp({
    subscriptions: ({ listId }) => [
      oneList.withParams({ listId }),
      todosInList.withParams({ listId }),
    ],
    mutations: {
      onAddTodo: ({
        mutate,
        listId,
        name,
        setName,
      }) => () => mutate(insert.withParams({ listId, name })).then(() => setName('')),
      onUpdateTodo: ({
        mutate,
      }) => ({ todoId, name, done }) => mutate(update.withParams({ todoId, name, done })),
    }
  }, {
    renderLoader: () => <div>Loading ...</div>,
  }),
  mapProps(({
    listId,
    collections,
    ...rest,
  }) => ({
    ...rest,
    list: collections[TodoList.collection][listId],
    todos: values(collections[Todo.collection]).filter(todo => todo.getListId() === listId),
  })),
  withHandlers({
    onChangeName: ({
      setName,
    }) => e => setName(e.currentTarget.value),
  }),
)(({
  list,
  todos,
  name,
  setName,
  onAddTodo,
  onChangeName,
  onUpdateTodo,
}) => (
  <div>
    <Link to="/lists/">Back</Link>
    <h1>{list && list.getTitle()}</h1>
    <ul>
      {todos.map(todo => (
        <ListItem key={todo._id} todo={todo} onUpdate={onUpdateTodo} />
      ))}
      <li>
        <input value={name} onChange={onChangeName}/>
        <button onClick={onAddTodo}>
          Add
        </button>
      </li>
    </ul>
  </div>
));

export default Lists;
