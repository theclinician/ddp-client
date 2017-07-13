let i = 0;

export function uniqueId() {
  const id = i.toString();
  i += 1;
  return id;
}

export const once = (func) => {
  let called = false;
  return (...args) => {
    if (!called) {
      called = true;
      if (func) {
        func(...args);
      }
    }
  };
};

export const omit = (object, keys) => {
  if (!keys || keys.length === 0) {
    return object;
  }
  const copy = { ...object };
  for (const key of keys) {
    delete copy[key];
  }
  return copy;
};
