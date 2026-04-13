/**
 * Realistic US geographic data for the data generator.
 *
 * Each location has consistent city/state/zip/lat/lon so generated
 * addresses are geographically plausible. Covers major and mid-size
 * markets across all states used by the generator.
 */

export interface GeoLocation {
  readonly city: string;
  readonly state: string;
  readonly zip: string;
  readonly lat: number;
  readonly lon: number;
  readonly streets: ReadonlyArray<string>;
}

/**
 * Representative locations across the 22 states the generator uses.
 * Multiple cities per state for variety. ZIP codes and coordinates
 * are real (or close approximations for the city center).
 */
export const US_LOCATIONS: ReadonlyArray<GeoLocation> = [
  // Alabama
  { city: 'Birmingham', state: 'AL', zip: '35203', lat: 33.5207, lon: -86.8025,
    streets: ['20th', 'Richard Arrington Jr', 'University', 'Clairmont', 'Oxmoor', 'Lakeshore'] },
  { city: 'Huntsville', state: 'AL', zip: '35801', lat: 34.7304, lon: -86.5861,
    streets: ['Governors', 'Memorial Pkwy', 'University', 'Bob Wallace', 'Jordan', 'Whitesburg'] },
  { city: 'Mobile', state: 'AL', zip: '36602', lat: 30.6954, lon: -88.0399,
    streets: ['Dauphin', 'Government', 'Spring Hill', 'Old Shell', 'Airport', 'Azalea'] },
  // Arizona
  { city: 'Phoenix', state: 'AZ', zip: '85004', lat: 33.4484, lon: -112.0740,
    streets: ['Camelback', 'Indian School', 'McDowell', 'Thomas', 'Bethany Home', 'Central'] },
  { city: 'Scottsdale', state: 'AZ', zip: '85251', lat: 33.4942, lon: -111.9261,
    streets: ['Scottsdale', 'Shea', 'Hayden', 'Pima', 'Frank Lloyd Wright', 'Pinnacle Peak'] },
  { city: 'Tucson', state: 'AZ', zip: '85701', lat: 32.2226, lon: -110.9747,
    streets: ['Speedway', 'Broadway', 'Grant', 'Oracle', 'Campbell', 'Tanque Verde'] },
  { city: 'Mesa', state: 'AZ', zip: '85201', lat: 33.4152, lon: -111.8315,
    streets: ['Main', 'Southern', 'Baseline', 'Dobson', 'Stapley', 'Lindsay'] },
  // California
  { city: 'Los Angeles', state: 'CA', zip: '90012', lat: 34.0522, lon: -118.2437,
    streets: ['Wilshire', 'Sunset', 'Santa Monica', 'Beverly', 'La Brea', 'Figueroa'] },
  { city: 'San Francisco', state: 'CA', zip: '94102', lat: 37.7749, lon: -122.4194,
    streets: ['Market', 'Mission', 'Valencia', 'Divisadero', 'Fulton', 'Irving'] },
  { city: 'San Diego', state: 'CA', zip: '92101', lat: 32.7157, lon: -117.1611,
    streets: ['Harbor', 'Broadway', 'University', 'El Cajon', 'Garnet', 'Morena'] },
  { city: 'Sacramento', state: 'CA', zip: '95814', lat: 38.5816, lon: -121.4944,
    streets: ['J', 'Capitol', 'Folsom', 'Alhambra', 'Freeport', 'Stockton'] },
  { city: 'Irvine', state: 'CA', zip: '92618', lat: 33.6846, lon: -117.8265,
    streets: ['Alton', 'Culver', 'Jamboree', 'Barranca', 'Sand Canyon', 'Jeffrey'] },
  // Colorado
  { city: 'Denver', state: 'CO', zip: '80202', lat: 39.7392, lon: -104.9903,
    streets: ['Colfax', 'Broadway', 'Speer', 'Alameda', 'Federal', 'Colorado'] },
  { city: 'Colorado Springs', state: 'CO', zip: '80903', lat: 38.8339, lon: -104.8214,
    streets: ['Tejon', 'Nevada', 'Platte', 'Academy', 'Powers', 'Cascade'] },
  { city: 'Boulder', state: 'CO', zip: '80302', lat: 40.0150, lon: -105.2705,
    streets: ['Pearl', 'Broadway', 'Baseline', 'Arapahoe', 'Canyon', 'Folsom'] },
  // Connecticut
  { city: 'Hartford', state: 'CT', zip: '06103', lat: 41.7658, lon: -72.6734,
    streets: ['Main', 'Asylum', 'Capitol', 'Farmington', 'Wethersfield', 'Albany'] },
  { city: 'Stamford', state: 'CT', zip: '06901', lat: 41.0534, lon: -73.5387,
    streets: ['Atlantic', 'Bedford', 'Summer', 'Broad', 'High Ridge', 'Tresser'] },
  { city: 'New Haven', state: 'CT', zip: '06510', lat: 41.3083, lon: -72.9279,
    streets: ['Chapel', 'Elm', 'Whitney', 'Whalley', 'Dixwell', 'Orange'] },
  // Florida
  { city: 'Miami', state: 'FL', zip: '33131', lat: 25.7617, lon: -80.1918,
    streets: ['Brickell', 'Flagler', 'Coral Way', 'Biscayne', 'Collins', 'Ocean'] },
  { city: 'Orlando', state: 'FL', zip: '32801', lat: 28.5383, lon: -81.3792,
    streets: ['Orange', 'Colonial', 'Mills', 'Magnolia', 'Church', 'Robinson'] },
  { city: 'Tampa', state: 'FL', zip: '33602', lat: 27.9506, lon: -82.4572,
    streets: ['Bayshore', 'Kennedy', 'Dale Mabry', 'Armenia', 'Howard', 'Platt'] },
  { city: 'Jacksonville', state: 'FL', zip: '32202', lat: 30.3322, lon: -81.6557,
    streets: ['Atlantic', 'Beach', 'San Marco', 'Riverside', 'Arlington', 'Hendricks'] },
  { city: 'Naples', state: 'FL', zip: '34102', lat: 26.1420, lon: -81.7948,
    streets: ['Gulf Shore', 'Tamiami', 'Pine Ridge', 'Vanderbilt', 'Goodlette-Frank', 'Pelican Bay'] },
  // Georgia
  { city: 'Atlanta', state: 'GA', zip: '30303', lat: 33.7490, lon: -84.3880,
    streets: ['Peachtree', 'Piedmont', 'Ponce de Leon', 'North Highland', 'Moreland', 'Decatur'] },
  { city: 'Savannah', state: 'GA', zip: '31401', lat: 32.0809, lon: -81.0912,
    streets: ['Broughton', 'Bull', 'Drayton', 'Abercorn', 'Habersham', 'Whitaker'] },
  { city: 'Augusta', state: 'GA', zip: '30901', lat: 33.4735, lon: -81.9748,
    streets: ['Broad', 'Walton Way', 'Washington', 'Greene', 'Reynolds', 'Telfair'] },
  // Illinois
  { city: 'Chicago', state: 'IL', zip: '60601', lat: 41.8781, lon: -87.6298,
    streets: ['Michigan', 'State', 'Clark', 'Halsted', 'Ashland', 'Western'] },
  { city: 'Naperville', state: 'IL', zip: '60540', lat: 41.7508, lon: -88.1535,
    streets: ['Washington', 'Ogden', 'Naper', 'Aurora', 'Bauer', 'Rickert'] },
  { city: 'Springfield', state: 'IL', zip: '62701', lat: 39.7817, lon: -89.6501,
    streets: ['Capitol', 'Adams', 'Monroe', 'Cook', 'MacArthur', 'Dirksen'] },
  // Massachusetts
  { city: 'Boston', state: 'MA', zip: '02108', lat: 42.3601, lon: -71.0589,
    streets: ['Boylston', 'Tremont', 'Commonwealth', 'Beacon', 'Newbury', 'Huntington'] },
  { city: 'Cambridge', state: 'MA', zip: '02139', lat: 42.3736, lon: -71.1097,
    streets: ['Massachusetts', 'Cambridge', 'Broadway', 'Hampshire', 'Prospect', 'Brattle'] },
  { city: 'Worcester', state: 'MA', zip: '01608', lat: 42.2626, lon: -71.8023,
    streets: ['Main', 'Park', 'Chandler', 'Pleasant', 'Salisbury', 'Highland'] },
  // Maryland
  { city: 'Baltimore', state: 'MD', zip: '21202', lat: 39.2904, lon: -76.6122,
    streets: ['Charles', 'Pratt', 'Light', 'Calvert', 'St Paul', 'Howard'] },
  { city: 'Bethesda', state: 'MD', zip: '20814', lat: 38.9807, lon: -77.0886,
    streets: ['Wisconsin', 'Old Georgetown', 'Arlington', 'Woodmont', 'Bradley', 'Norfolk'] },
  { city: 'Annapolis', state: 'MD', zip: '21401', lat: 38.9784, lon: -76.4922,
    streets: ['Main', 'West', 'Duke of Gloucester', 'Maryland', 'Compromise', 'Prince George'] },
  // Michigan
  { city: 'Detroit', state: 'MI', zip: '48226', lat: 42.3314, lon: -83.0458,
    streets: ['Woodward', 'Michigan', 'Grand River', 'Gratiot', 'Jefferson', 'Livernois'] },
  { city: 'Ann Arbor', state: 'MI', zip: '48104', lat: 42.2808, lon: -83.7430,
    streets: ['Main', 'Liberty', 'Huron', 'State', 'Washtenaw', 'Plymouth'] },
  { city: 'Grand Rapids', state: 'MI', zip: '49503', lat: 42.9634, lon: -85.6681,
    streets: ['Monroe', 'Fulton', 'Division', 'Wealthy', 'Lake', 'Bridge'] },
  // Minnesota
  { city: 'Minneapolis', state: 'MN', zip: '55401', lat: 44.9778, lon: -93.2650,
    streets: ['Hennepin', 'Nicollet', 'Lake', 'Lyndale', 'Portland', 'Cedar'] },
  { city: 'Saint Paul', state: 'MN', zip: '55101', lat: 44.9537, lon: -93.0900,
    streets: ['Summit', 'Grand', 'University', 'Selby', 'Snelling', 'Lexington'] },
  { city: 'Rochester', state: 'MN', zip: '55901', lat: 44.0121, lon: -92.4802,
    streets: ['Broadway', 'Second', 'Civic Center', 'Salem', 'Assisi', 'Elton Hills'] },
  // North Carolina
  { city: 'Charlotte', state: 'NC', zip: '28202', lat: 35.2271, lon: -80.8431,
    streets: ['Tryon', 'Trade', 'South', 'Providence', 'Sharon', 'Park'] },
  { city: 'Raleigh', state: 'NC', zip: '27601', lat: 35.7796, lon: -78.6382,
    streets: ['Fayetteville', 'Hillsborough', 'Glenwood', 'Capital', 'Western', 'New Bern'] },
  { city: 'Durham', state: 'NC', zip: '27701', lat: 35.9940, lon: -78.8986,
    streets: ['Main', 'Gregson', 'Mangum', 'Duke', 'Chapel Hill', 'Roxboro'] },
  { city: 'Asheville', state: 'NC', zip: '28801', lat: 35.5951, lon: -82.5515,
    streets: ['Biltmore', 'Patton', 'Haywood', 'Merrimon', 'Charlotte', 'Tunnel'] },
  // New Jersey
  { city: 'Newark', state: 'NJ', zip: '07102', lat: 40.7357, lon: -74.1724,
    streets: ['Broad', 'Market', 'Raymond', 'Mulberry', 'Clinton', 'Springfield'] },
  { city: 'Jersey City', state: 'NJ', zip: '07302', lat: 40.7178, lon: -74.0431,
    streets: ['Grove', 'Newark', 'Montgomery', 'Marin', 'Jersey', 'Columbus'] },
  { city: 'Princeton', state: 'NJ', zip: '08540', lat: 40.3573, lon: -74.6672,
    streets: ['Nassau', 'Witherspoon', 'Alexander', 'Palmer Square', 'Stockton', 'Mercer'] },
  // New York
  { city: 'New York', state: 'NY', zip: '10001', lat: 40.7128, lon: -74.0060,
    streets: ['Broadway', 'Madison', 'Lexington', 'Park', 'Amsterdam', 'Columbus'] },
  { city: 'Buffalo', state: 'NY', zip: '14202', lat: 42.8864, lon: -78.8784,
    streets: ['Delaware', 'Elmwood', 'Main', 'Hertel', 'Niagara', 'Allen'] },
  { city: 'Albany', state: 'NY', zip: '12207', lat: 42.6526, lon: -73.7562,
    streets: ['State', 'Pearl', 'Madison', 'Lark', 'Central', 'Washington'] },
  { city: 'White Plains', state: 'NY', zip: '10601', lat: 41.0340, lon: -73.7629,
    streets: ['Mamaroneck', 'Main', 'Westchester', 'Post', 'Court', 'Martine'] },
  // Ohio
  { city: 'Columbus', state: 'OH', zip: '43215', lat: 39.9612, lon: -82.9988,
    streets: ['High', 'Broad', 'Neil', 'Third', 'Front', 'Rich'] },
  { city: 'Cleveland', state: 'OH', zip: '44113', lat: 41.4993, lon: -81.6944,
    streets: ['Euclid', 'Superior', 'Detroit', 'Carnegie', 'Lorain', 'Pearl'] },
  { city: 'Cincinnati', state: 'OH', zip: '45202', lat: 39.1031, lon: -84.5120,
    streets: ['Vine', 'Main', 'Race', 'Elm', 'Central', 'Reading'] },
  // Oregon
  { city: 'Portland', state: 'OR', zip: '97201', lat: 45.5152, lon: -122.6784,
    streets: ['Burnside', 'Hawthorne', 'Division', 'Alberta', 'Belmont', 'Sandy'] },
  { city: 'Eugene', state: 'OR', zip: '97401', lat: 44.0521, lon: -123.0868,
    streets: ['Willamette', 'Pearl', 'Olive', 'Coburg', 'River', 'Franklin'] },
  { city: 'Bend', state: 'OR', zip: '97701', lat: 44.0582, lon: -121.3153,
    streets: ['Wall', 'Bond', 'Newport', 'Galveston', 'Franklin', 'Greenwood'] },
  // Pennsylvania
  { city: 'Philadelphia', state: 'PA', zip: '19103', lat: 39.9526, lon: -75.1652,
    streets: ['Broad', 'Market', 'Walnut', 'Chestnut', 'South', 'Passyunk'] },
  { city: 'Pittsburgh', state: 'PA', zip: '15222', lat: 40.4406, lon: -79.9959,
    streets: ['Forbes', 'Fifth', 'Liberty', 'Penn', 'Butler', 'Carson'] },
  { city: 'King of Prussia', state: 'PA', zip: '19406', lat: 40.0893, lon: -75.3963,
    streets: ['DeKalb', 'Gulph', 'Henderson', 'Warner', 'Allendale', 'Croton'] },
  // Rhode Island
  { city: 'Providence', state: 'RI', zip: '02903', lat: 41.8240, lon: -71.4128,
    streets: ['Westminster', 'Thayer', 'Wickenden', 'Hope', 'Broad', 'Elmwood'] },
  { city: 'Newport', state: 'RI', zip: '02840', lat: 41.4901, lon: -71.3128,
    streets: ['Thames', 'Bellevue', 'Spring', 'Broadway', 'Memorial', 'Ocean'] },
  // Texas
  { city: 'Austin', state: 'TX', zip: '78701', lat: 30.2672, lon: -97.7431,
    streets: ['Congress', 'Lamar', 'Guadalupe', 'South First', 'Burnet', 'Manor'] },
  { city: 'Dallas', state: 'TX', zip: '75201', lat: 32.7767, lon: -96.7970,
    streets: ['Elm', 'Commerce', 'McKinney', 'Ross', 'Greenville', 'Lemmon'] },
  { city: 'Houston', state: 'TX', zip: '77002', lat: 29.7604, lon: -95.3698,
    streets: ['Main', 'Westheimer', 'Montrose', 'Richmond', 'Kirby', 'Fannin'] },
  { city: 'San Antonio', state: 'TX', zip: '78205', lat: 29.4241, lon: -98.4936,
    streets: ['Commerce', 'Houston', 'Broadway', 'St Mary', 'Alamo', 'Navarro'] },
  { city: 'Fort Worth', state: 'TX', zip: '76102', lat: 32.7555, lon: -97.3308,
    streets: ['Main', 'Houston', 'Throckmorton', 'Camp Bowie', 'Magnolia', 'Hemphill'] },
  // Virginia
  { city: 'Richmond', state: 'VA', zip: '23219', lat: 37.5407, lon: -77.4360,
    streets: ['Broad', 'Main', 'Cary', 'Grace', 'Franklin', 'Monument'] },
  { city: 'Arlington', state: 'VA', zip: '22201', lat: 38.8816, lon: -77.0910,
    streets: ['Wilson', 'Clarendon', 'Columbia Pike', 'Glebe', 'Fairfax', 'Lee'] },
  { city: 'Virginia Beach', state: 'VA', zip: '23451', lat: 36.8529, lon: -75.9780,
    streets: ['Atlantic', 'Pacific', 'Shore', 'Laskin', 'Virginia Beach', 'Independence'] },
  // Washington
  { city: 'Seattle', state: 'WA', zip: '98101', lat: 47.6062, lon: -122.3321,
    streets: ['Pike', 'Pine', 'Aurora', 'Rainier', 'Denny', 'Madison'] },
  { city: 'Bellevue', state: 'WA', zip: '98004', lat: 47.6101, lon: -122.2015,
    streets: ['Bellevue Way', 'Main', 'NE 8th', 'NE 4th', '108th', '148th'] },
  { city: 'Tacoma', state: 'WA', zip: '98402', lat: 47.2529, lon: -122.4443,
    streets: ['Pacific', 'Broadway', 'Tacoma', 'Sixth', 'Proctor', 'Stadium'] },
  { city: 'Spokane', state: 'WA', zip: '99201', lat: 47.6588, lon: -117.4260,
    streets: ['Division', 'Monroe', 'Sprague', 'Riverside', 'Hamilton', 'Grand'] },
];

/** Pick a random location. */
export const randomLocation = (): GeoLocation =>
  US_LOCATIONS[Math.floor(Math.random() * US_LOCATIONS.length)];

/** Add slight jitter to coordinates so multiple properties in the same
 *  city do not share exact lat/lon. Jitter is ~0.01 degrees (~1 km). */
export const jitterCoords = (lat: number, lon: number): { lat: number; lon: number } => ({
  lat: lat + (Math.random() - 0.5) * 0.02,
  lon: lon + (Math.random() - 0.5) * 0.02,
});
