import { hashPassword } from '../security/password.js'

const password = process.argv[2]
if (!password) {
  console.error('Usage: npm run hash-password -- <password>')
  process.exit(1)
}
console.log(await hashPassword(password))
