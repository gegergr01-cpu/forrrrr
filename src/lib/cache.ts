import { unstable_cache } from 'next/cache';
import prisma from '@/lib/prisma';

// Sensitive secret keys that must NEVER be leaked to public cache or RSC props
const HIDDEN_SETTING_KEYS = new Set([
  'STRIPE_SECRET_KEY',
  'PAYPAL_SECRET',
  'CRON_SECRET',
  'SMTP_PASSWORD',
  'SMTP_PASS',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SETUP_TOKEN',
]);

// Helper to get raw settings (excluding sensitive payment and service credentials)
async function fetchSettings() {
  const settingsDb = await prisma.setting.findMany();
  return settingsDb
    .filter(s => !HIDDEN_SETTING_KEYS.has(s.key))
    .reduce((acc, s) => ({ ...acc, [s.key]: s.value }), {} as Record<string, string>);
}

// Cached version of settings
export const getCachedSettings = unstable_cache(
  async () => fetchSettings(),
  ['global-settings'],
  { tags: ['settings'], revalidate: 3600 }
);

/**
 * Standard minimal projection for Product Cards & Catalog views.
 * EXCLUDES heavy HTML descriptions, large JSON technical specs, and unused relations.
 * Reduces database egress by ~95% on catalog/list queries.
 */
export const PRODUCT_CARD_SELECT = {
  id: true,
  title: true,
  slug: true,
  price: true,
  compareAtPrice: true,
  images: true,
  discountLabel: true,
  type: true,
  isBestSeller: true,
  isDealOfTheDay: true,
  gtin: true,
  categories: {
    select: {
      id: true,
      name: true,
      slug: true,
    }
  },
  reviews: {
    where: { isApproved: true },
    select: {
      rating: true,
    }
  }
} as const;

/**
 * Standard minimal projection for Blog Articles cards/lists.
 * EXCLUDES the massive article HTML content.
 */
export const ARTICLE_CARD_SELECT = {
  id: true,
  title: true,
  slug: true,
  image: true,
  excerpt: true,
  category: true,
  createdAt: true,
  updatedAt: true,
  authorName: true,
  _count: {
    select: {
      comments: { where: { isApproved: true } }
    }
  }
} as const;

// We need a helper for dynamic tags per slug since unstable_cache tags must be statically defined in the wrapper
// A common pattern is a factory function:
export const getCachedProductBySlug = async (slug: string) => {
  return unstable_cache(
    async () => {
      const encodedSlugLower = encodeURIComponent(slug).toLowerCase();
      const encodedSlugUpper = encodeURIComponent(slug);
      let decodedSlug = slug;
      try { decodedSlug = decodeURIComponent(slug); } catch (e) {}

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slug);

      let product = await prisma.product.findFirst({
        where: { 
          isDeleted: false,
          OR: [
            { slug: slug },
            { slug: encodedSlugLower },
            { slug: encodedSlugUpper },
            { slug: decodedSlug },
            ...(isUuid ? [{ id: slug }] : [])
          ]
        },
        include: {
          categories: true,
          Product_ForceSales_A: true,
          Product_SaleTogether_A: true,
          brand: true,
          tags: true,
          reviews: {
            where: { isApproved: true },
            orderBy: { createdAt: 'desc' },
            include: { user: { select: { email: true } } }
          }
        }
      });

      // SEO Migration Fallback 1: If not found, check if a product exists with slug matching `${decodedSlug}-*` (suffix appended during WP/WooCommerce import)
      if (!product) {
        product = await prisma.product.findFirst({
          where: {
            isDeleted: false,
            slug: {
              startsWith: `${decodedSlug}-`
            }
          },
          include: {
            categories: true,
            Product_ForceSales_A: true,
            Product_SaleTogether_A: true,
            brand: true,
            tags: true,
            reviews: {
              where: { isApproved: true },
              orderBy: { createdAt: 'desc' },
              include: { user: { select: { email: true } } }
            }
          }
        });
      }

      // SEO Migration Fallback 2: If not found and input slug ends with numeric suffix (e.g. `-481`), check without suffix
      if (!product && /-\d+$/.test(decodedSlug)) {
        const strippedSlug = decodedSlug.replace(/-\d+$/, '');
        product = await prisma.product.findFirst({
          where: {
            isDeleted: false,
            slug: strippedSlug
          },
          include: {
            categories: true,
            Product_ForceSales_A: true,
            Product_SaleTogether_A: true,
            brand: true,
            tags: true,
            reviews: {
              where: { isApproved: true },
              orderBy: { createdAt: 'desc' },
              include: { user: { select: { email: true } } }
            }
          }
        });
      }

      if (!product) return null;

      // RGPD: Never leak raw emails to client RSC payload
      const sanitizedReviews = product.reviews.map(r => ({
        id: r.id,
        productId: r.productId,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
        reviewerName: r.reviewerName || (r.user?.email ? r.user.email.split('@')[0] : 'Client'),
      }));

      return {
        ...product,
        reviews: sanitizedReviews,
      };
    },
    ['product-details', slug],
    { tags: ['products', `product-${slug}`], revalidate: 3600 }
  )();
};

export const getCachedRelatedProducts = async (categoryIds: string[], excludeProductId: string) => {
  // Sort IDs so the cache key is consistent
  const sortedIds = [...categoryIds].sort();
  return unstable_cache(
    async () => prisma.product.findMany({
      where: { 
        isDeleted: false,
        categories: { some: { id: { in: categoryIds } } }, 
        id: { not: excludeProductId } 
      },
      select: PRODUCT_CARD_SELECT,
      take: 4,
    }),
    ['related-products', sortedIds.join(','), excludeProductId],
    { tags: ['products'], revalidate: 3600 }
  )();
};

// Caching for Homepage best sellers
export const getCachedBestSellers = unstable_cache(
  async () => prisma.product.findMany({
    where: { isBestSeller: true, isDeleted: false },
    take: 8,
    select: PRODUCT_CARD_SELECT
  }),
  ['home-best-sellers'],
  { tags: ['products'], revalidate: 3600 }
);

// Caching for Homepage latest products
export const getCachedLatestProducts = unstable_cache(
  async () => prisma.product.findMany({
    where: { isDeleted: false },
    take: 8,
    orderBy: { createdAt: 'desc' },
    select: PRODUCT_CARD_SELECT
  }),
  ['home-latest-products'],
  { tags: ['products'], revalidate: 3600 }
);

// Caching categories tree (only categories with >0 products, structured hierarchically)
export const getCachedCategoriesTree = unstable_cache(
  async () => {
    const allCategories = await prisma.category.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        parentId: true,
        _count: {
          select: { products: true }
        }
      },
      orderBy: { name: 'asc' }
    });

    // Only keep categories that have at least 1 product
    const withProducts = allCategories.filter(c => c._count.products > 0);

    // Organize hierarchically: roots first, followed by their children
    const roots = withProducts.filter(c => !c.parentId);
    const children = withProducts.filter(c => c.parentId);

    const childrenByParent = new Map<string, typeof withProducts>();
    for (const child of children) {
      if (child.parentId) {
        if (!childrenByParent.has(child.parentId)) {
          childrenByParent.set(child.parentId, []);
        }
        childrenByParent.get(child.parentId)!.push(child);
      }
    }

    const result: Array<{ id: string; name: string; slug: string | null; parentId: string | null }> = [];

    function addChildren(parentId: string) {
      const directChildren = childrenByParent.get(parentId) || [];
      for (const ch of directChildren) {
        result.push({
          id: ch.id,
          name: ch.name,
          slug: ch.slug,
          parentId: ch.parentId
        });
        addChildren(ch.id);
      }
    }

    for (const root of roots) {
      result.push({
        id: root.id,
        name: root.name,
        slug: root.slug,
        parentId: null
      });
      addChildren(root.id);
    }

    // Include any remaining child category whose root had 0 direct products
    for (const ch of children) {
      if (!result.find(r => r.id === ch.id)) {
        result.push({
          id: ch.id,
          name: ch.name,
          slug: ch.slug,
          parentId: ch.parentId
        });
      }
    }

    return result;
  },
  ['header-categories-with-products'],
  { tags: ['categories', 'products'], revalidate: 3600 }
);

export const getCachedProductCounts = unstable_cache(
  async () => {
    const [newCount, hotCount, saleCount] = await Promise.all([
      prisma.product.count({ where: { isDeleted: false } }),
      prisma.product.count({ where: { isDeleted: false, orderItems: { some: {} } } }),
      prisma.product.count({ where: { isDeleted: false, compareAtPrice: { not: null } } })
    ]);
    return { newCount, hotCount, saleCount };
  },
  ['layout-product-counts'],
  { tags: ['products'], revalidate: 3600 }
);

/**
 * Caches sidebar filter metadata for the Shop / Catalog page.
 * Avoids 3 separate database calls (category counts, brand counts, min/max prices) on every shop visit.
 */
export const getCachedShopFilterMetadata = unstable_cache(
  async () => {
    const [allCategories, allBrands, priceAgg] = await Promise.all([
      prisma.category.findMany({
        select: {
          id: true,
          name: true,
          slug: true,
          _count: {
            select: { products: { where: { isDeleted: false } } }
          }
        },
        orderBy: { name: 'asc' }
      }),
      prisma.brand.findMany({
        select: {
          id: true,
          name: true,
          slug: true,
          _count: {
            select: { products: { where: { isDeleted: false } } }
          }
        },
        orderBy: { name: 'asc' }
      }),
      prisma.product.aggregate({
        where: { isDeleted: false },
        _min: { price: true },
        _max: { price: true }
      })
    ]);

    return {
      allCategories,
      allBrands,
      globalMinPrice: Math.floor(priceAgg._min?.price || 0),
      globalMaxPrice: Math.ceil(priceAgg._max?.price || 1000)
    };
  },
  ['shop-filter-metadata'],
  { tags: ['products', 'categories', 'brands'], revalidate: 3600 }
);

/**
 * Caches Homepage products and thermal simulation buckets.
 * Avoids full-table scan and in-memory classification on every homepage hit.
 */
export const getCachedHomepageProducts = unstable_cache(
  async () => {
    const allDbProds = await prisma.product.findMany({
      where: { isDeleted: false },
      select: {
        id: true,
        title: true,
        slug: true,
        price: true,
        compareAtPrice: true,
        images: true,
        discountLabel: true,
        isBestSeller: true,
        gtin: true,
        brand: { select: { name: true } },
        categories: { select: { name: true, slug: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 200
    });

    const formattedProducts = allDbProds.map(p => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      price: p.price,
      compareAtPrice: p.compareAtPrice,
      images: p.images || [],
      discountLabel: p.discountLabel || (p.compareAtPrice && p.compareAtPrice > p.price ? `-${Math.round(((p.compareAtPrice - p.price) / p.compareAtPrice) * 100)}%` : null),
      categorySlug: p.categories[0]?.slug || '',
      categoryName: p.categories[0]?.name || '',
      categories: p.categories.map(c => ({ name: c.name, slug: c.slug || '' })),
      allCategories: p.categories.map(c => `${c.name} ${c.slug}`).join(' ')
    }));

    const promoProducts = formattedProducts.filter(p =>
      (p.compareAtPrice && p.compareAtPrice > p.price) ||
      (p.discountLabel && p.discountLabel.trim() !== '')
    );

    const simulatorProducts = {
      pallets: [] as any[],
      fireplaces: [] as any[],
      climate: [] as any[]
    };

    const classify = (p: any) => {
      const t = p.title.toLowerCase();
      if (
        t.includes('salamandra') ||
        t.includes('recuperador') ||
        t.includes('lareira') ||
        t.includes('fogão') ||
        t.includes('fogao') ||
        t.includes('forno') ||
        t.includes('aquecedor') ||
        t.includes('radiador') ||
        t.includes('caldeira') ||
        t.includes('cozinha') ||
        t.includes('estufa')
      ) {
        return 'fireplaces';
      }
      if (
        t.includes('ar condicionado') ||
        t.includes('split') ||
        t.includes('climatiz') ||
        t.includes('desumidificador') ||
        t.includes('ventilador') ||
        t.includes('termoacumulador')
      ) {
        return 'climate';
      }
      if (
        t.includes('palete') ||
        t.includes('palet') ||
        t.includes('pellet') ||
        t.includes('lenha') ||
        t.includes('big bag') ||
        t.includes('aparas') ||
        t.includes('carvão') ||
        t.includes('carvao') ||
        t.includes('bioetanol') ||
        t.includes('combust')
      ) {
        return 'pallets';
      }
      return 'fireplaces';
    };

    for (const p of allDbProds) {
      const type = classify(p);
      simulatorProducts[type].push({
        id: p.id,
        title: p.title,
        slug: p.slug,
        price: p.price,
        image: p.images?.[0] || '',
        categoryName: p.categories?.[0]?.name || '',
        brand: p.brand?.name || undefined,
        sku: p.gtin || undefined
      });
    }

    const heroShowcaseProducts = formattedProducts
      .filter(p => p.images && p.images.length > 0)
      .slice(0, 8)
      .map(p => {
        const savings = p.compareAtPrice && p.compareAtPrice > p.price ? p.compareAtPrice - p.price : 0;
        const discountPct = p.compareAtPrice && p.compareAtPrice > p.price
          ? Math.round(((p.compareAtPrice - p.price) / p.compareAtPrice) * 100)
          : null;
        return {
          id: p.id,
          title: p.title,
          subtitle: p.categoryName ? `${p.categoryName} • Alta Eficiência EcoDesign` : 'Qualidade Garantida Silva Dias',
          price: p.price,
          compareAtPrice: p.compareAtPrice,
          image: p.images[0],
          badge: discountPct ? `POUPANÇA -${discountPct}%` : 'TOP VENDAS',
          badgeTech: p.categoryName ? `🔥 ${p.categoryName}` : '🔥 Alto Rendimento',
          badgeTech2: savings > 0 ? `Poupe ${savings.toFixed(2).replace('.', ',')} €` : 'Stock Garantido',
          categoryName: p.categoryName || '',
          discountLabel: p.discountLabel || (discountPct ? `-${discountPct}%` : null),
          savings,
          discountPct
        };
      });

    return {
      formattedProducts,
      promoProducts,
      simulatorProducts,
      heroShowcaseProducts
    };
  },
  ['homepage-products-data'],
  { tags: ['products'], revalidate: 3600 }
);

/**
 * Caches Hot Products with minimal projection.
 */
export const getCachedHotProducts = unstable_cache(
  async () => prisma.product.findMany({
    where: { isDeleted: false },
    select: PRODUCT_CARD_SELECT,
    orderBy: {
      orderItems: {
        _count: 'desc'
      }
    },
    take: 40
  }),
  ['hot-products-list'],
  { tags: ['products'], revalidate: 3600 }
);

/**
 * Caches New Arrival Products with minimal projection.
 */
export const getCachedNewProducts = unstable_cache(
  async () => prisma.product.findMany({
    where: { isDeleted: false },
    select: PRODUCT_CARD_SELECT,
    orderBy: { createdAt: 'desc' },
    take: 12
  }),
  ['new-products-list'],
  { tags: ['products'], revalidate: 3600 }
);

/**
 * Caches Sale Products with minimal projection.
 */
export const getCachedSaleProducts = unstable_cache(
  async () => prisma.product.findMany({
    where: {
      isDeleted: false,
      compareAtPrice: { not: null }
    },
    select: PRODUCT_CARD_SELECT,
    orderBy: { updatedAt: 'desc' },
    take: 50
  }),
  ['sale-products-list'],
  { tags: ['products'], revalidate: 3600 }
);

/**
 * Caches default shipping rate for product details page.
 */
export const getCachedDefaultShippingRate = unstable_cache(
  async () => {
    const ptZone = await prisma.shippingZone.findFirst({
      where: { name: { in: ['PT', 'Portugal', 'DE'] }, isActive: true },
      include: { methods: { where: { isActive: true }, orderBy: { rate: 'asc' } } }
    });
    return ptZone?.methods?.[0]?.rate ?? 0;
  },
  ['default-shipping-rate'],
  { tags: ['shipping'], revalidate: 86400 }
);

/**
 * Caches Blog Articles for the index page. Excludes HTML content body.
 */
export const getCachedBlogArticles = async (query?: string) => {
  const safeQuery = query?.trim().toLowerCase() || '';
  return unstable_cache(
    async () => prisma.article.findMany({
      where: {
        isPublished: true,
        ...(safeQuery ? { title: { contains: safeQuery, mode: 'insensitive' } } : {})
      },
      select: ARTICLE_CARD_SELECT,
      orderBy: { createdAt: 'desc' }
    }),
    ['blog-articles-list', safeQuery],
    { tags: ['blogs'], revalidate: 3600 }
  )();
};

/**
 * Caches recent articles for sidebars and widgets. Excludes HTML content body.
 */
export const getCachedRecentArticles = async (limit: number = 5, excludeId?: string) => {
  return unstable_cache(
    async () => prisma.article.findMany({
      where: {
        isPublished: true,
        ...(excludeId ? { id: { not: excludeId } } : {})
      },
      select: {
        id: true,
        title: true,
        slug: true,
        image: true,
        createdAt: true,
        category: true
      },
      orderBy: { createdAt: 'desc' },
      take: limit
    }),
    ['recent-articles', limit.toString(), excludeId || 'none'],
    { tags: ['blogs'], revalidate: 3600 }
  )();
};

/**
 * Caches blog article detail by slug.
 */
export const getCachedArticleBySlug = async (slug: string) => {
  return unstable_cache(
    async () => prisma.article.findUnique({
      where: { slug },
      include: {
        comments: {
          where: { isApproved: true },
          orderBy: { createdAt: 'desc' }
        }
      }
    }),
    ['article-by-slug', slug],
    { tags: ['blogs', `blog-${slug}`], revalidate: 3600 }
  )();
};
