// Recently viewed products — purely a client-side convenience.
// Kept separate from the cart store since it has no Shopify side.

const STORAGE_KEY = 'sr_recent';
const MAX_ITEMS = 12;

export type RecentlyViewedItem = {
  handle: string;
  title: string;
  image?: string;
  price?: string;
};

function load(): RecentlyViewedItem[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

export const recentlyViewed = {
  getItems(): RecentlyViewedItem[] {
    return load();
  },
  add(item: RecentlyViewedItem): void {
    if (typeof localStorage === 'undefined') return;
    const items = load().filter((i) => i.handle !== item.handle);
    items.unshift(item);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
    } catch {
      /* quota / privacy mode — silently skip */
    }
  },
};
