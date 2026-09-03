// Pre-generated pool of ~120 nostalgic, time-specific and casual chat phrases for initial channel titles

export const MORNING_PHRASES = [
  "Early Bird Catchin' Worms",
  "Rise and Shine",
  "Morning Coffee Club",
  "Dawn Patrol",
  "Fresh Pot of Joe",
  "Breakfast of Champions",
  "AM Chill & Chat",
  "Top of the Morning",
  "First Light Chit-Chat",
  "Wakey Wakey",
  "Caffeine & Comics",
  "Early Brew Crew",
];

export const AFTERNOON_PHRASES = [
  "Afternoon Slump",
  "Lunch Break Lounge",
  "Midday Musings",
  "Sunny Disposition",
  "High Noon Hangout",
  "Post-Lunch Daze",
  "Coffee Break",
  "Catching Rays",
  "Second Wind",
  "Desk Jockey Hour",
  "Afternoon Breeze",
  "Clock Watching",
];

export const EVENING_PHRASES = [
  "Punching the Clock",
  "Happy Hour Hangout",
  "Sunset Strip",
  "Evening Unwind",
  "Dinnertime Doodles",
  "Twilight Talk",
  "Post-Work Chill",
  "Golden Hour Gossip",
  "Evening Shenanigans",
  "Dinner & A Show",
  "Kicking Back",
  "Calling It a Day",
];

export const NIGHT_PHRASES = [
  "Burnin' the Midnight Oil",
  "Night Owls Anonymous",
  "Midnight Ramblings",
  "Late Night Lounge",
  "The Witching Hour",
  "Can't Sleep Club",
  "Ghost Town Gossip",
  "After Hours Den",
  "Insomniac Central",
  "Stargazer Corner",
  "Moonlit Musings",
  "The 2 AM Crew",
  "Third Shift Hangout",
  "Dreamland Waiting Room",
];

export const GENERAL_PHRASES = [
  "Hanging Around",
  "Shoot the Breeze",
  "Chewing the Fat",
  "Just Another Day",
  "The Water Cooler",
  "Shooting the Breeze",
  "Loitering with Intent",
  "The Daily Grind",
  "Chilling in the Corner",
  "Idle Chatter",
  "Talking in Circles",
  "The Speakeasy",
  "Passing the Time",
  "Coffee & Ink",
  "Penny for Your Thoughts",
  "Spilling the Tea",
  "Two Cents' Worth",
  "Shootin' the Bull",
  "Nothing to See Here",
  "Don't Look Now",
  "Out of Left Field",
  "Off the Record",
  "Behind Closed Doors",
  "The Funny Papers",
  "Sunday Strip",
  "Panel by Panel",
  "In the Margins",
  "Between the Lines",
  "Word Balloon Alley",
  "Comic Relief",
  "Living in a Cartoon",
  "Drawn That Way",
  "Ink & Paper",
  "The Drawing Board",
  "Back to Square One",
  "Speaking of Which",
  "Between You and Me",
  "Word on the Street",
  "The Grapevine",
  "Small Talk Central",
  "The Porch Swing",
  "Front Row Seat",
  "Casual Corner",
  "The Clubhouse",
  "Hideout & Chill",
  "Secret Handshake",
  "Kickin' Tires",
  "Watchin' the Grass Grow",
  "Killing Time",
  "Taking Five",
  "Down the Rabbit Hole",
  "Spontaneous Combustion",
  "As Luck Would Have It",
  "Under the Radar",
  "Off the Beaten Path",
  "The Living Room",
  "Cozy Fireside",
  "Corner Booth",
  "Diner Talk",
  "Jukebox Jive",
  "Radio Waves",
  "Static on the Line",
  "Broadcasting Live",
  "Under the Table",
  "Round and Round",
  "All in a Day's Work",
  "Hold My Drink",
  "Wait for It",
  "Another Fine Mess",
  "The Usual Suspects",
];

/**
 * Randomly select either the time-of-day pool or the overall general pool,
 * and then randomly select a phrase from that pool as the channel title.
 */
export function getRandomChannelTitle(): string {
  const now = new Date();
  const hour = now.getHours();

  let timePool: string[];
  if (hour >= 5 && hour < 12) {
    timePool = MORNING_PHRASES;
  } else if (hour >= 12 && hour < 17) {
    timePool = AFTERNOON_PHRASES;
  } else if (hour >= 17 && hour < 22) {
    timePool = EVENING_PHRASES;
  } else {
    timePool = NIGHT_PHRASES;
  }

  // 50% probability of selecting the time-specific pool, 50% for overall general pool
  const useTimePool = Math.random() < 0.5;
  const pool = useTimePool ? timePool : GENERAL_PHRASES;
  const randomIndex = Math.floor(Math.random() * pool.length);
  return pool[randomIndex];
}

/**
 * Get or initialize a random channel title for a specific conversation ID.
 * Persists in localStorage if available.
 */
export function getOrInitChannelTitle(convId: string): string {
  const key = `aircomic_channel_title_${convId}`;
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  if (saved && saved.trim()) {
    return saved.trim();
  }
  const generated = getRandomChannelTitle();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, generated);
    }
  } catch (err) {
    console.warn('Failed to save channel title to localStorage:', err);
  }
  return generated;
}
