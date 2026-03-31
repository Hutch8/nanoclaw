/**
 * Bluesky MCP Server for NanoClaw
 * Exposes Bluesky API tools for the container agent.
 * Authenticates with app credentials to search posts and get trending feed.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BLUESKY_IDENTIFIER = process.env.BLUESKY_IDENTIFIER || '';
const BLUESKY_APP_PASSWORD = process.env.BLUESKY_APP_PASSWORD || '';
const ATP_BASE_URL = 'https://bsky.social/xrpc';

let accessJwt: string | null = null;

function log(msg: string): void {
  console.error(`[BLUESKY] ${msg}`);
}

/**
 * Lazy-initialize session on first API call.
 * Uses com.atproto.server.createSession with app password credentials.
 */
async function ensureAuthenticated(): Promise<string> {
  if (accessJwt) {
    return accessJwt;
  }

  if (!BLUESKY_IDENTIFIER || !BLUESKY_APP_PASSWORD) {
    throw new Error('Bluesky credentials not configured. Set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD.');
  }

  try {
    log(`Authenticating as ${BLUESKY_IDENTIFIER}...`);
    const res = await fetch(`${ATP_BASE_URL}/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: BLUESKY_IDENTIFIER,
        password: BLUESKY_APP_PASSWORD,
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Auth failed: ${res.status} ${res.statusText} - ${error}`);
    }

    const session = await res.json() as { accessJwt?: string };
    if (!session.accessJwt) {
      throw new Error('No accessJwt in session response');
    }

    accessJwt = session.accessJwt;
    log(`Authenticated successfully`);
    return accessJwt;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Bluesky authentication failed: ${msg}`);
  }
}

const server = new McpServer({
  name: 'bluesky',
  version: '1.0.0',
});

server.tool(
  'bluesky_search_posts',
  'Search for posts on Bluesky. Returns post text, author handle, engagement metrics, and timestamps.',
  {
    query: z.string().describe('Search query (e.g., "AI", "climate change", "#trending")'),
    limit: z.number().optional().describe('Number of posts to return (default 25)'),
    sort: z.enum(['top', 'latest']).optional().describe('Sort order: "top" (engagement-based) or "latest" (time-based, default)'),
  },
  async (args) => {
    try {
      const jwt = await ensureAuthenticated();
      const limit = args.limit || 25;
      const sort = args.sort || 'top';

      log(`Searching for "${args.query}" (limit=${limit}, sort=${sort})...`);

      const params = new URLSearchParams({
        q: args.query,
        limit: String(Math.min(limit, 100)),
        sort,
      });

      const res = await fetch(`${ATP_BASE_URL}/app.bsky.feed.searchPosts?${params}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      if (!res.ok) {
        if (res.status === 401) {
          accessJwt = null; // Reset token on auth failure
        }
        const error = await res.text();
        return {
          content: [{ type: 'text' as const, text: `Bluesky search error (${res.status}): ${error}` }],
          isError: true,
        };
      }

      const data = await res.json() as {
        posts?: Array<{
          uri: string;
          author?: { handle: string; displayName?: string };
          record?: { text: string };
          likeCount?: number;
          replyCount?: number;
          indexedAt?: string;
        }>;
      };

      const posts = data.posts || [];
      if (posts.length === 0) {
        return { content: [{ type: 'text' as const, text: `No posts found for "${args.query}"` }] };
      }

      const formatted = posts
        .map((p, i) => {
          const author = p.author?.handle || 'unknown';
          const displayName = p.author?.displayName ? ` (${p.author.displayName})` : '';
          const text = p.record?.text || '[no text]';
          const likes = p.likeCount || 0;
          const replies = p.replyCount || 0;
          const timestamp = p.indexedAt ? new Date(p.indexedAt).toLocaleDateString() : 'unknown';
          return `${i + 1}. @${author}${displayName}\n   "${text.slice(0, 200)}${text.length > 200 ? '...' : ''}"\n   ❤️ ${likes} | 💬 ${replies} | ${timestamp}\n   ${p.uri}`;
        })
        .join('\n\n');

      log(`Found ${posts.length} posts for "${args.query}"`);
      return { content: [{ type: 'text' as const, text: formatted }] };
    } catch (err) {
      log(`Search error: ${err instanceof Error ? err.message : String(err)}`);
      return {
        content: [{ type: 'text' as const, text: `Bluesky search failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'bluesky_get_trending',
  'Get trending posts from Bluesky. Searches for highly-engaged posts and returns them sorted by popularity/engagement.',
  {
    limit: z.number().optional().describe('Number of posts to return (default 30)'),
  },
  async (args) => {
    try {
      const jwt = await ensureAuthenticated();
      const limit = args.limit || 30;

      log(`Fetching trending posts (limit=${limit})...`);

      // Search for trending content using broad queries sorted by engagement
      const params = new URLSearchParams({
        q: 'today', // Broad query that captures current discourse
        limit: String(Math.min(limit, 100)),
        sort: 'top', // Sort by engagement (likes + replies)
      });

      const res = await fetch(`${ATP_BASE_URL}/app.bsky.feed.searchPosts?${params}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      if (!res.ok) {
        if (res.status === 401) {
          accessJwt = null; // Reset token on auth failure
        }
        const error = await res.text();
        return {
          content: [{ type: 'text' as const, text: `Bluesky API error (${res.status}): ${error}` }],
          isError: true,
        };
      }

      const data = await res.json() as {
        posts?: Array<{
          uri: string;
          author?: { handle: string; displayName?: string };
          record?: { text: string };
          likeCount?: number;
          replyCount?: number;
          indexedAt?: string;
        }>;
      };

      const posts = data.posts || [];
      if (posts.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No trending posts found' }] };
      }

      const formatted = posts
        .map((p, i) => {
          const author = p.author?.handle || 'unknown';
          const displayName = p.author?.displayName ? ` (${p.author.displayName})` : '';
          const text = p.record?.text || '[no text]';
          const likes = p.likeCount || 0;
          const replies = p.replyCount || 0;
          const timestamp = p.indexedAt ? new Date(p.indexedAt).toLocaleDateString() : 'unknown';
          return `${i + 1}. @${author}${displayName}\n   "${text.slice(0, 200)}${text.length > 200 ? '...' : ''}"\n   ❤️ ${likes} | 💬 ${replies} | ${timestamp}\n   ${p.uri}`;
        })
        .join('\n\n');

      log(`Got ${posts.length} trending posts`);
      return { content: [{ type: 'text' as const, text: formatted }] };
    } catch (err) {
      log(`Trending fetch error: ${err instanceof Error ? err.message : String(err)}`);
      return {
        content: [{ type: 'text' as const, text: `Bluesky trending fetch failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
