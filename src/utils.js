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
