/**
 * The server's MCP `instructions`, declared in one place.
 *
 * Sent once at initialize, so it costs nothing per request and still reaches the model before its
 * first tool call. The tool descriptions in `tools.ts` say what each tool does. This says who is
 * being talked to.
 *
 * The audience is the reason it exists. A RESO Web API server holds data belonging to people who
 * know real estate and know their own records, and who have no reason to know OData. An assistant
 * that answers them in field names and filter syntax is answering a question nobody asked, and
 * published RESO material has had exactly that note back from its readers.
 *
 * It lives in its own module rather than in `index.ts` because that file ends in a top-level
 * `await server.connect(...)`: importing it to read a string would start a server on stdin. This
 * module has no side effects, so a test or another reader can import it safely.
 */
export const SERVER_INSTRUCTIONS = [
  'These tools read and write RESO Web API data: listings, media, open houses, showings, members, offices and change feeds.',
  '',
  'Assume the person you are talking to knows real estate and knows their own data, and not necessarily more than that. Answer in the terms they used, such as listings, bedrooms, price, acreage, city and brokerage. Keep field names, OData filters, parsers and query syntax out of your answers unless they ask how something works, and then explain it plainly.',
  '',
  'Never state a number you did not get from a query, and never close a gap by estimating. If the data cannot answer the question, say so and say what would.',
  '',
  'Credentials live in this server environment. Do not ask the person for a token, a client id or a secret, and do not put one in a tool call. If a call fails for want of a credential, name the environment variable that is missing.'
].join('\n');
