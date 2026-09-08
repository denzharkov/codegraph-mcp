import { saveUser } from './db.js';

export function createUserHandler(req) {
  return saveUser(req.body);
}

export function listUsersHandler() {
  return [];
}
