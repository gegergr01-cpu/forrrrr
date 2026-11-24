import { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';
import { getCachedSettings } from '@/lib/cache';

const DEFAULT_DISALLOW_PATHS = [
  '/admin/',
  '/account/',
  '/checkout/',
  '/cart',
  '/api/',
  '/search',
  '/search/*',
  '/*?sort=',
  '/*?page=',
  '/*?filter=',
  '/*?q=',
  '/*?category=',
  '/*?brand=',
  '/*?minPrice=',
  '/*?maxPrice=',
  '/*?rating=',
  '/*?view=',
  '/*?filter_cat=',
  '/*?column=',
  '/*?per_page=',
  '/*?rating_filter=',
  '/*?stock_status=',
  '/*?featured=',
  '/*?best_seller=',
  '/*?add-to-cart='
];

const BLOCKED_BOTS = [
  'SemrushBot',
  'SemrushBot-SA',
  'AhrefsBot',
  'PetalBot',
  'DotBot',
  'MJ12bot',
  'DataForSeoBot',
  'Bytespider',
  'GPTBot',
  'CCBot',
];

export default async function robots(): Promise<MetadataRoute.Robots> {
  const baseUrl = SITE_URL;

  // Read robots settings from cache instead of direct uncached database query
  const settingsMap = await getCachedSettings();

  // Parse disallow paths from DB or use defaults
  let disallowPaths: string[] = DEFAULT_DISALLOW_PATHS;
  if (settingsMap['ROBOTS_DISALLOW_PATHS']) {
    try {
      const custom = JSON.parse(settingsMap['ROBOTS_DISALLOW_PATHS']);
      if (Array.isArray(custom)) {
        disallowPaths = Array.from(new Set([...DEFAULT_DISALLOW_PATHS, ...custom]));
      }
    } catch {
      disallowPaths = DEFAULT_DISALLOW_PATHS;
    }
  }

  // Parse crawl delay (optional)
  const crawlDelay = settingsMap['ROBOTS_CRAWL_DELAY']
    ? parseInt(settingsMap['ROBOTS_CRAWL_DELAY'], 10)
    : undefined;

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: disallowPaths,
        ...(crawlDelay && !isNaN(crawlDelay) ? { crawlDelay } : {}),
      },
      {
        userAgent: BLOCKED_BOTS,
        disallow: ['/'],
      }
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
