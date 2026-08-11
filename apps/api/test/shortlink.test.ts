import { test, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app';

let app: any;
const prisma = new PrismaClient();

beforeAll(async () => {
  app = Fastify();
  await buildApp(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('Shortlink creation and redirection', async () => {
  const url = 'https://example.com/very-long-url-' + Math.random();
  
  // Create shortlink
  const createRes = await app.inject({
    method: 'POST',
    url: '/shortlinks',
    payload: { url }
  });
  
  expect(createRes.statusCode).toBe(201);
  const data = JSON.parse(createRes.payload);
  expect(data.url).toBe(url);
  expect(data.slug).toBeDefined();

  // Test redirection
  const redirectRes = await app.inject({
    method: 'GET',
    url: `/s/${data.slug}`
  });
  
  expect(redirectRes.statusCode).toBe(302);
  expect(redirectRes.headers.location).toBe(url);
});

test('Shortlink with custom slug', async () => {
  const url = 'https://example.com';
  const slug = 'custom-' + Math.random().toString(36).substring(7);
  
  const createRes = await app.inject({
    method: 'POST',
    url: '/shortlinks',
    payload: { url, slug }
  });
  
  expect(createRes.statusCode).toBe(201);
  const data = JSON.parse(createRes.payload);
  expect(data.slug).toBe(slug);
});

test('Shortlink duplicate slug fails', async () => {
  const slug = 'duplicate-' + Math.random().toString(36).substring(7);
  
  await app.inject({
    method: 'POST',
    url: '/shortlinks',
    payload: { url: 'https://a.com', slug }
  });
  
  const res = await app.inject({
    method: 'POST',
    url: '/shortlinks',
    payload: { url: 'https://b.com', slug }
  });
  
  expect(res.statusCode).toBe(400);
});
