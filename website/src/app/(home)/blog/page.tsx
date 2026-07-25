import Link from 'next/link';
import type { Metadata } from 'next';
import { blogSource } from '@/lib/blog-source';
import { formatAuthors, formatDate } from '@/lib/format';

export const metadata: Metadata = {
  title: 'Blog',
  description: 'Updates and announcements from the HourGlass team.',
};

export default function BlogIndexPage() {
  const posts = [...blogSource.getPages()].sort(
    (a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime(),
  );

  return (
    <main className="max-w-3xl mx-auto px-6 md:px-8 py-16">
      <header className="mb-12">
        <h1 className="text-4xl font-semibold tracking-tight m-0">Blog</h1>
        <p className="text-fd-muted-foreground mt-3 m-0">
          Updates and announcements from the HourGlass team.
        </p>
      </header>

      {posts.length === 0 ? (
        <p className="text-fd-muted-foreground">No posts yet. Check back soon.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-fd-border list-none p-0 m-0">
          {posts.map((post) => (
            <li key={post.url} className="py-6">
              <Link href={post.url} className="group block no-underline">
                <h2 className="text-xl font-semibold text-fd-foreground m-0 group-hover:text-[color:var(--accent)] transition-colors">
                  {post.data.title}
                </h2>
                {post.data.description && (
                  <p className="text-sm text-fd-muted-foreground mt-2 m-0">{post.data.description}</p>
                )}
                <div className="flex items-center gap-2 mt-3 text-xs text-fd-muted-foreground flex-wrap">
                  <span>{formatAuthors(post.data.author)}</span>
                  <span aria-hidden>·</span>
                  <time dateTime={new Date(post.data.date).toISOString()}>{formatDate(post.data.date)}</time>
                  {post.data.tags && post.data.tags.length > 0 && (
                    <>
                      <span aria-hidden>·</span>
                      <span>{post.data.tags.join(', ')}</span>
                    </>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
