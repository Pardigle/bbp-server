// api/webhook.js
// Receives Shopify "orders/paid" webhook
// Saves customer to Supabase + tags them in Shopify

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Verify the request genuinely came from Shopify
function verifyShopifyWebhook(rawBody, hmacHeader) {
  const hash = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  return hash === hmacHeader;
}

// Tag the customer in Shopify as "ashape-reviewer"
async function tagShopifyCustomer(customerId) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN; // e.g. bluebotprep.myshopify.com
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  // First get existing tags
  const getRes = await fetch(
    `https://${shop}/admin/api/2024-01/customers/${customerId}.json`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );
  const getData = await getRes.json();
  const existingTags = getData.customer?.tags || '';

  // Add our tag if not already there
  if (existingTags.includes('ashape-reviewer')) return;
  const newTags = existingTags
    ? `${existingTags}, ashape-reviewer`
    : 'ashape-reviewer';

  await fetch(
    `https://${shop}/admin/api/2024-01/customers/${customerId}.json`,
    {
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ customer: { id: customerId, tags: newTags } }),
    }
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Read raw body for HMAC verification
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');

  // Verify it's really Shopify
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!verifyShopifyWebhook(rawBody, hmac)) {
    console.error('Webhook verification failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const order = JSON.parse(rawBody);

  // Only process if this order contains our product
  // Check by product title or tag — adjust to match your Shopify product name
  const hasReviewerProduct = order.line_items?.some(
    (item) =>
      item.title?.toLowerCase().includes('ashape') ||
      item.title?.toLowerCase().includes('reviewer')
  );

  if (!hasReviewerProduct) {
    // Not our product, ignore silently
    return res.status(200).json({ ok: true, skipped: true });
  }

  const customer = order.customer;
  if (!customer) {
    return res.status(200).json({ ok: true, skipped: 'no customer' });
  }

  // Upsert customer into Supabase
  const { error: dbError } = await supabase
    .from('customers')
    .upsert(
      {
        shopify_id: String(customer.id),
        email: customer.email,
        name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
      },
      { onConflict: 'shopify_id' }
    );

  if (dbError) {
    console.error('Supabase error:', dbError);
    return res.status(500).json({ error: 'DB error' });
  }

  // Tag them in Shopify
  try {
    await tagShopifyCustomer(customer.id);
  } catch (e) {
    // Non-fatal — customer is in DB, tagging can be retried
    console.error('Shopify tagging error:', e);
  }

  console.log(`Provisioned customer: ${customer.email}`);
  return res.status(200).json({ ok: true });
}
