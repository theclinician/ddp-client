import React from 'react';
import { Link } from 'react-router-dom';
import ddp from '../common/utils/ddp';
import {
  values,
} from 'lodash';
import {
  compose,
  mapProps,
  withState,
  withHandlers,
} from 'recompose';
import {
  insert,
  allLists,
} from '../common/api/TodoLists';
import TodoList from '../common/models/TodoList.js';

const Lists = compose(
  withState('title', 'setTitle', ''),
  ddp({
    subscriptions: () => [
      allLists.withParams(),
    ],
    mutations: {
      onAddList: ({
        title,
        setTitle,
        mutate,
      }) => () => mutate(insert.withParams({ title })).then(() => setTitle(''))
    }
  }, {
    renderLoader: () => <div>Loading ...</div>,
  }),
  mapProps(({
    collections,
    ...rest
  }) => ({
    ...rest,
    lists: values(collections[TodoList.collection]),
  })),
  withHandlers({
    onChangeTitle: ({
      setTitle,
    }) => e => setTitle(e.currentTarget.value),
  }),
)(({
  lists,
  title,
  setTitle,
  onAddList,
  onChangeTitle,
}) => (
  <div>
    <ul>
      {lists.map(list => (
        <li key={list._id}>
          <Link to={`/lists/${list._id}`}>
            {list.title}
          </Link>
        </li>
      ))}
      <li>
        <input value={title} onChange={onChangeTitle}/>
        <button onClick={onAddList}>
          Add list
        </button>
      </li>
    </ul>
  </div>
));

export default Lists;
