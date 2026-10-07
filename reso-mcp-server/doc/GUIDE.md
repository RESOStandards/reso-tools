# MCP Guide for RESO Web API Servers

The RESO MCP server lets an AI assistant answer questions about listings and other Web API data a user has access to without accessing the API directly. It uses the same client SDK RESO uses for certification for data access, meaning it only talks to Web API servers using standard queries and capabilities.

That means the MCP server can also be used to add or edit listings, maintain media, offices and members, or synchronize data from a feed if the Web API server the user is connecting supports it and they're authorized.

## Getting Started

### Authorization

Credentials never belong in a chat. 

Create a `.env` file in the same directory as the RESO MCP Server source code:

**Bearer Token**
```
RESO_BASE_URL=https://your-server.example.com
RESO_AUTH_TOKEN=your-token
```

**Client Credentials**
```
RESO_BASE_URL=https://your-server.example.com
RESO_CLIENT_ID=your-client-id
RESO_CLIENT_SECRET=your-client-secret
RESO_TOKEN_URI=https://your-server.example.com/oauth/token
```

`RESO_BASE_URL` is important and should be verified so credentials aren't exposed to the wrong server.

AI assistants should never interact with authorization information directly. Additionally, keep `.env` out of version control. 

### Docker

First, download Docker and RESO Tools, then build the image:

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Download the source: `git clone https://github.com/RESOStandards/reso-tools.git`
3. From the `reso-tools` directory, build it:

```
docker build -f reso-mcp-server/Dockerfile -t reso-mcp-server .
```

4. Start it:

```
docker run --rm -i --env-file .env reso-mcp-server
```

Keep the `-i`. Without it the server exits right away and looks like it worked.

Using Claude Code, Codex or another coding assistant? Ask it to do all of this for you.

RESO also hosts a cloud MCP server at `services.reso.org/mcp`, with no local installation needed. It's in beta for members. Contact **dev@reso.org** for a key, or for help with any of the above.

## Authorization and Data Usage
Authorization relates to the data the user has access to on an API and available capabilities, like searching or updating data. 

It doesn't cover what users can do with that data once they have access. Most services have data licensing agreements, and it's important to review terms and data usage rights to see what's covered.


## Exploring Listings and Related Data

Once credentials are set up, it's easy to explore RESO data. 

> **User**: Show me the top 10 most recent 3bd residential listings between $1-2m with pools and at least one acre in Austin

The assistant creates the RESO Web API query and sends it to the MCP server to fetch data from the API, then explains it to the user. 

No matches on this exact search, and the AI agent explains why,

> **Assistant**: I didn't find anything that matches your criteria exactly, but here's the breakdown:
>
> | criteria | listings |
> |---|---|
> | in Austin | 46 |
> | still Active | 32 |
> | typed Residential | 2 |
> | with exactly 3 bedrooms | 0 |
>
> "3bd" rules out anything with four or five bedrooms. If three or more is fine, there's one in Austin.
>
> <details><summary>Tool call and response – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     "resource": "Property",
>     "filter": "City eq 'Austin' and StandardStatus eq 'Active' and PropertyType eq 'Residential' and BedroomsTotal ge 3 and ListPrice ge 1000000 and ListPrice le 2000000 and PoolPrivateYN eq true and LotSizeAcres ge 1",
>     "select": "ListingKey,UnparsedAddress,ListPrice,BedroomsTotal,BathroomsTotalInteger,LivingArea,LotSizeAcres,YearBuilt",
>     "orderby": "ModificationTimestamp desc",
>     "top": 10
>   }
> }
> ```
>
> ```json
> {
>   "@odata.context": ".../$metadata#Property",
>   "value": [
>     {
>       "ListingKey": "9ae36f5f-1acd-404c-8be8-f02aae3cabf5",
>       "UnparsedAddress": "6719 South First Drive",
>       "ListPrice": 1928110,
>       "BedroomsTotal": 5,
>       "BathroomsTotalInteger": 3,
>       "LivingArea": 5395,
>       "LotSizeAcres": 89.92,
>       "YearBuilt": 1984
>     }
>   ]
> }
> ```
>
> </details>
>
> <br>
>
> **User**: Three or more is fine.
>
> **Assistant**: There's a listing on 6719 South First Drive in Austin for $1,928,110. It has 5 bedrooms, 3 baths, 5,395 sq ft, 89.92 acres, built 1984. In-ground gunite pool.

Users can also ask about related information, like media.

> **User**: Show me the photos for that listing.
>
> **Assistant**: There are five media items, and only one is a photo of the property.
>
> | | description | category | file | image |
> |---|---|---|---|---|
> | 1 | Front exterior view | Photo | `xls` | [view](https://picsum.photos/seed/9ae36f5f-1acd-404c-8be8-f02aae3cabf5-0/800/600) |
> | 2 | Laundry room | Branded Virtual Tour | `txt` | [view](https://picsum.photos/seed/9ae36f5f-1acd-404c-8be8-f02aae3cabf5-1/800/600) |
> | 3 | Master bedroom | Video | `wmv` | [view](https://picsum.photos/seed/9ae36f5f-1acd-404c-8be8-f02aae3cabf5-2/800/600) |
> | 4 | Patio | Office Photo | `quicktime` | [view](https://picsum.photos/seed/9ae36f5f-1acd-404c-8be8-f02aae3cabf5-3/800/600) |
> | 5 | Laundry room | Video | `rtf` | [view](https://picsum.photos/seed/9ae36f5f-1acd-404c-8be8-f02aae3cabf5-4/800/600) |
>
> Every one of them has a live image behind it, including the records whose file type says spreadsheet or text, so the type on the record is not what the server actually serves. The one marked as the preferred photo is the front exterior view, and its record says `xls`. The patio image is categorized as an office photo, which is a photo of a brokerage rather than a listing. The second item is marked Deleted and still came back.
>
> <details><summary>Tool call and response – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     "resource": "Media",
>     "filter": "ResourceRecordKey eq '9ae36f5f-1acd-404c-8be8-f02aae3cabf5'",
>     "select": "Order,ShortDescription,MediaCategory,MediaType,MediaStatus,PreferredPhotoYN,MediaURL"
>   }
> }
> ```
>
> ```json
> {
>   "value": [
>     {
>       "Order": 1,
>       "ShortDescription": "Front exterior view",
>       "MediaCategory": "Photo",
>       "MediaType": "xls",
>       "MediaStatus": "Complete",
>       "PreferredPhotoYN": true,
>       "MediaURL": "https://picsum.photos/seed/9ae36f5f-.../800/600"
>     },
>     {
>       "Order": 2,
>       "ShortDescription": "Laundry room",
>       "MediaCategory": "Branded Virtual Tour",
>       "MediaType": "txt",
>       "MediaStatus": "Deleted",
>       "PreferredPhotoYN": null,
>       "MediaURL": "https://picsum.photos/seed/9ae36f5f-.../800/600"
>     }
>   ]
> }
> ```
>
> </details>
>
> <br>
>
> **User**: When can someone see it?
>
> **Assistant**: There are two open houses, both livestreamed. June 27 for brokers, and May 23 for the public with an appointment required.
>
> Two showings are booked, May 10 and May 24. Neither records which agent requested it.
>
> <details><summary>Tool call and response – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     "resource": "OpenHouse",
>     "filter": "ListingKey eq '9ae36f5f-1acd-404c-8be8-f02aae3cabf5'",
>     "select": "OpenHouseKey,OpenHouseDate,OpenHouseType,OpenHouseStatus,AppointmentRequiredYN"
>   }
> }
> ```
>
> ```json
> {
>   "value": [
>     {
>       "OpenHouseDate": "2026-06-27",
>       "OpenHouseType": "Livestream Broker",
>       "OpenHouseStatus": "Active",
>       "AppointmentRequiredYN": false
>     },
>     {
>       "OpenHouseDate": "2026-05-23",
>       "OpenHouseType": "Livestream Public",
>       "OpenHouseStatus": "Active",
>       "AppointmentRequiredYN": true
>     }
>   ]
> }
> ```
>
> </details>
>
> <br>
>
> **User**: Is it a green home?
>
> **Assistant**: The listing names one certification, NGBS Whole-Home Remodel, and reports power production from photovoltaics and wind.
>
> One thing to note. The separate verification record names a different certification, a Home Energy Upgrade Certificate of Energy Efficiency Improvements, and the green verified flag is not set either way. If you are marketing this as green, that is the gap to close.
>
> <details><summary>Tool call and response – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     "resource": "PropertyGreenVerification",
>     "filter": "ListingKey eq '9ae36f5f-1acd-404c-8be8-f02aae3cabf5'",
>     "select": "GreenBuildingVerificationType,Body,Year,Rating,Status,Metric"
>   }
> }
> ```
>
> ```json
> {
>   "value": [
>     {
>       "GreenBuildingVerificationType": "Home Energy Upgrade Certificate of Energy Efficiency Improvements",
>       "Body": null,
>       "Year": null,
>       "Rating": null,
>       "Status": null,
>       "Metric": null
>     }
>   ]
> }
> ```
>
> </details>
>
> <br>
>
> **User**: What's in the house?
>
> **Assistant**: A sound system inside, a convection oven and an in-ground gunite pool. Views of a garden, bridges and a vineyard. Flooring is listed as concrete and also as "Varies".
>
> The exterior features list is empty.
>
> <details><summary>Tool call and response – <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     "resource": "Property",
>     "filter": "ListingKey eq '9ae36f5f-1acd-404c-8be8-f02aae3cabf5'",
>     "select": "InteriorFeatures,ExteriorFeatures,Appliances,Flooring,PoolFeatures,View,WaterfrontFeatures,WaterfrontYN"
>   }
> }
> ```
>
> ```json
> {
>   "value": [
>     {
>       "InteriorFeatures": ["Sound System"],
>       "ExteriorFeatures": [],
>       "Appliances": ["Convection Oven"],
>       "Flooring": ["Varies", "Concrete"],
>       "PoolFeatures": ["In Ground", "Gunite"],
>       "View": ["Garden", "Bridge(s)", "Vineyard"],
>       "WaterfrontFeatures": [],
>       "WaterfrontYN": false
>     }
>   ]
> }
> ```
>
> </details>

<br />

Any of this works by typing or by voice, so an agent can ask from the driveway.

## Adding and Editing Data

If your Web API server supports it, users can also add and change data. This is for agents, brokers and MLSs who want to maintain their data this way, not only read it.

> **User**: Add a new listing at 1850 Willamette Street in Eugene.
>
> **Assistant**: I need four things before the server will create it: city, state, postal code and country. I have Eugene. What is the ZIP?
>
> **User**: 97405, Oregon, US.
>
> **Assistant**: Created. There is no price, status or bedroom count on it yet.
>
> <details><summary>Tool call and response – <code>mcp__reso__create</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__create",
>   "arguments": {
>     "resource": "Property",
>     "record": {
>       "City": "Eugene",
>       "StateOrProvince": "OR",
>       "PostalCode": "97405",
>       "Country": "US"
>     }
>   }
> }
> ```
>
> ```json
> {
>   "status": 201,
>   "body": {
>     "ListingKey": "768ead6a-7106-4a50-9cf4-375250f48804",
>     "City": "Eugene",
>     "StandardStatus": null,
>     "ListPrice": null
>   }
> }
> ```
>
> </details>

<br />

Business rules are reported as the server sees them, all at once rather than one at a time.

> **User**: Three bedrooms, two baths, 2,100 square feet, built 2004, list it at "a lot" for now.
>
> **Assistant**: There are three problems with that.
>
> - `BedroomsTotl` is a typo for `BedroomsTotal`
> - `BathroomsTotalIntegerr` has an extra R
> - The list price has to be a number, and "a lot" is not one
>
> Would you like me to fix the two spellings and leave the price out until you have one?
>
> <details><summary>Tool call and response – <code>mcp__reso__update</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__update",
>   "arguments": {
>     "resource": "Property",
>     "key": "768ead6a-7106-4a50-9cf4-375250f48804",
>     "record": {
>       "BedroomsTotl": 3,
>       "BathroomsTotalIntegerr": 2,
>       "ListPrice": "a lot"
>     }
>   }
> }
> ```
>
> ```json
> {
>   "error": {
>     "code": "20100",
>     "message": "3 validation errors occurred",
>     "target": "Update",
>     "details": [
>       { "target": "BedroomsTotl", "message": "'BedroomsTotl' is not a recognized field. Check field name spelling or consult the metadata." },
>       { "target": "BathroomsTotalIntegerr", "message": "'BathroomsTotalIntegerr' is not a recognized field. Check field name spelling or consult the metadata." },
>       { "target": "ListPrice", "message": "Must be a number." }
>     ]
>   }
> }
> ```
>
> </details>
>
> <br>
>
> **User**: Yes, and make it 825,000.
>
> **Assistant**: Done. The listing is now 1850 Willamette Street, Eugene, OR at $825,000, with 3 bedrooms, 2 baths, 2,100 sq ft, built 2004, Residential and Active.

Users can confirm a change landed rather than taking the word for it.

> **User**: Did that actually save?
>
> **Assistant**: Yes. I read the record back from the server and every field matches what we sent.

## Members and Offices

Agents and offices work the same way, so there is nothing new to learn.

> **User**: How many offices do we have, and how many in Eugene?
>
> **Assistant**: There are 707 offices, 13 of them in Eugene.
>
> **User**: Add Spencer Butte Realty, 1850 Willamette Street, Eugene, Oregon.
>
> **Assistant**: The server needs the same four as the listing: city, state, postal code and country. I have the first two.
>
> **User**: 97405, US.
>
> **Assistant**: Created.
>
> **User**: Add Marisol Vega there, REALTOR Salesperson, Oregon license.
>
> **Assistant**: The same four again. Should I use her address or the office's?
>
> **User**: The office's.
>
> **Assistant**: Created and attached to Spencer Butte Realty.
>
> <details><summary>Tool call and response – <code>mcp__reso__create</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__create",
>   "arguments": {
>     "resource": "Member",
>     "record": {
>       "MemberFirstName": "Marisol",
>       "MemberLastName": "Vega",
>       "MemberType": "REALTOR Salesperson",
>       "MemberStateLicense": "OR-201377"
>     }
>   }
> }
> ```
>
> ```json
> {
>   "error": {
>     "message": "4 validation errors occurred",
>     "details": [
>       { "target": "MemberCity", "message": "MemberCity is required." },
>       { "target": "MemberStateOrProvince", "message": "MemberStateOrProvince is required." },
>       { "target": "MemberPostalCode", "message": "MemberPostalCode is required." },
>       { "target": "MemberCountry", "message": "MemberCountry is required." }
>     ]
>   }
> }
> ```
>
> That is the refusal before an address is supplied. Adding `MemberCity`, `MemberStateOrProvince`, `MemberPostalCode` and `MemberCountry` returns `201`.
>
> </details>

<br />

City, state, postal code and country, for listings, offices and members alike. Everything else the server takes as it is given.

Some things a server will not catch, and those are worth asking about directly. This one accepted a new agent with no MLS ID when every other agent on it has one, and it will keep a full name that no longer matches a corrected last name.

## Keeping Data in Sync

Users feeding another system need to know what changed.

> **User**: What listings changed in the last hour?
>
> **Assistant**: One, the Eugene listing we just created.

That works on any server. It finds records that still exist and still match, so a deleted listing never appears and nothing tells you to remove it from your copy.

A server that supports EntityEvent can do better, and users can watch it work.

> **User**: Cancel the May 23 open house on the Austin listing.
>
> **Assistant**: Cancelled. Its status went from Active to Canceled.
>
> **User**: Did the change feed pick that up?
>
> **Assistant**: Yes. There is one new entry pointing at that open house, and the record reads Canceled.
>
> <details><summary>Tool call and response – <code>mcp__reso__update</code> then <code>mcp__reso__query</code></summary>
>
> ```jsonc
> {
>   "tool": "mcp__reso__update",
>   "arguments": {
>     "resource": "OpenHouse",
>     "key": "0ff31d7d-43c6-4370-a487-7e41c048c0c2",
>     "record": { "OpenHouseStatus": "Canceled" }
>   }
> }
> ```
>
> ```jsonc
> {
>   "tool": "mcp__reso__query",
>   "arguments": {
>     "resource": "EntityEvent",
>     "filter": "EntityEventSequence gt 243377",
>     "orderby": "EntityEventSequence",
>     "select": "EntityEventSequence,ResourceName,ResourceRecordKey"
>   }
> }
> ```
>
> ```json
> {
>   "value": [
>     {
>       "EntityEventSequence": 243378,
>       "ResourceName": "OpenHouse",
>       "ResourceRecordKey": "0ff31d7d-43c6-4370-a487-7e41c048c0c2"
>     }
>   ]
> }
> ```
>
> </details>

<br />

That is the loop a syncing system runs: change something, see it in the feed, confirm the record. One entry, one thing to update, nothing else re-read.

Asking what changed since a timestamp tells users what a record looks like now. The change feed tells them something happened. Keeping another system in step needs the second.

## Additional Topics

### Architecture

[Architecture](ARCHITECTURE.md) covers how the server is built: what each tool does and where it goes, how authorization is handled, and how to adapt the same pattern to tools of your own.

### MCP Tools

There are ten MCP tools. For reading: query, metadata and parse-filter. For writing: create, update and delete. Then authorize, two certification tools available when the server runs in certification mode, and a validate tool that is not wired up yet.

An AI assistant never makes its own web request and never holds a credential. Everything goes through the MCP server, which reads the credential from `.env` and attaches it. That is what the setup section protects: a secret the server holds rather than a secret in a conversation.

### Why the Breakdown Appears

When a search matches nothing, the server tells the assistant to show which part of the question emptied the results, with real counts rather than estimates. It offers that once, and again after three empty searches in a row. Advice repeated on every miss stops being advice.

### The Change Feed

EntityEvent is a RESO resource holding one numbered entry per change, each naming the record and where to re-read it. The numbers only go up, so a consumer stores the last one it saw and asks for everything after it. That is what makes a sync complete rather than approximate, and why a deletion is visible there and invisible to a timestamp search.

### The Certification Tools

In certification mode the server also exposes the RESO certification test runner and the metadata report generator. These are the same tools RESO uses to certify a server, so implementers can run them against their own work while they build rather than finding out at certification time.

### About These Examples

Every number above came from a real query against a seeded sample server, not a live market. The sample includes a preferred photo stored as a spreadsheet, a listing and its verification record naming different certifications, and flooring listed as both concrete and "Varies". Tool calls are shown to see how the MCP server translates natural language into RESO Web API queries. 
