'use client';

import { useState } from 'react';

export default function ShortlinkPage() {
  const [url, setUrl] = useState('');
  const [slug, setSlug] = useState('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResult(null);

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'}/shortlinks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, slug: slug || undefined }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create shortlink');
      }

      const data = await res.json();
      setResult(data);
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-12 px-4">
      <h1 className="text-3xl font-bold mb-8">Shortlink Clone</h1>
      
      <form onSubmit={handleSubmit} className="space-y-4 mb-12">
        <div>
          <label className="block text-sm font-medium mb-1">Target URL</label>
          <input
            type="url"
            required
            className="w-full p-2 border rounded text-black"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Custom Slug (optional)</label>
          <input
            type="text"
            className="w-full p-2 border rounded text-black"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my-link"
          />
        </div>
        <button
          type="submit"
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          Create Shortlink
        </button>
      </form>

      {error && <div className="text-red-500 mb-4">{error}</div>}

      {result && (
        <div className="p-4 bg-green-50 border border-green-200 rounded text-green-800">
          <p className="font-medium">Shortlink created!</p>
          <p className="mt-2">
            URL: <a href={`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'}/s/${result.slug}`} target="_blank" className="underline">
              {process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'}/s/{result.slug}
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
