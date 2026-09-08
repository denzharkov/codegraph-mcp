export function saveUser(user) {
  return validate(user) && persist(user);
}

function validate(u) {
  return !!u.name;
}

function persist() {
  return true;
}
