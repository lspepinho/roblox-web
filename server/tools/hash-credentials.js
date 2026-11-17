import { makeCredential } from "../src/credentials.js";

const [username = "admin", password = "admin"] = process.argv.slice(2);
console.log("PROXY_USERNAME_SCRYPT=" + makeCredential(username));
console.log("PROXY_PASSWORD_SCRYPT=" + makeCredential(password));
