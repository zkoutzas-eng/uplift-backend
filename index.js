require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const Stripe = require('stripe');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe webhooks need the raw request body to verify the signature
// so we set up a special raw parser for that route BEFORE the json parser
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json());

// ─── COMPANY SIGNUP ───────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  const { company_name, email } = req.body;
  if (!company_name || !email) return res.status(400).json({ error: 'Missing fields' });

  const { data, error } = await supabase
    .from('companies')
    .insert([{ name: company_name, email }])
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  await resend.emails.send({
    from: 'Uplift <hello@upliftau.com>',
    to: email,
    subject: 'Welcome to Uplift! Here is how to get started.',
    html: `
      <div style="font-family: Georgia, serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; color: #161210;">
        <h1 style="font-size: 28px; margin-bottom: 16px;">Welcome to Uplift, ${company_name}!</h1>
        <p style="font-size: 16px; line-height: 1.7; color: #5C4A3A;">Your 14 day free trial has started. Your team is about to start their mornings differently.</p>
        <p style="font-size: 16px; line-height: 1.7; color: #5C4A3A;">Head to your dashboard to add your employees and get everything set up.</p>
        <a href="${process.env.DASHBOARD_URL || 'https://upliftau.com/dashboard'}?company=${data.id}" 
           style="display: inline-block; margin-top: 24px; background: #2D5A3D; color: white; padding: 14px 32px; border-radius: 99px; text-decoration: none; font-size: 15px;">
          Set up my team
        </a>
        <p style="margin-top: 40px; font-size: 13px; color: #9C8472;">The Uplift team</p>
      </div>
    `
  });

  res.json({ success: true, company: data });
});

// ─── ADD EMPLOYEES ─────────────────────────────────────────────────
app.post('/api/employees', async (req, res) => {
  const { company_id, employees } = req.body;
  if (!company_id || !employees?.length) return res.status(400).json({ error: 'Missing fields' });

  const rows = employees.map(e => ({ company_id, name: e.name, email: e.email }));
  const { data, error } = await supabase.from('employees').insert(rows).select();
  if (error) return res.status(400).json({ error: error.message });

  await supabase.from('companies').update({ employee_count: employees.length }).eq('id', company_id);

  for (const emp of data) {
    await resend.emails.send({
      from: 'Uplift <hello@upliftau.com>',
      to: emp.email,
      subject: `${emp.name}, your mornings are about to get better`,
      html: `
        <div style="font-family: Georgia, serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; color: #161210;">
          <h1 style="font-size: 26px; margin-bottom: 16px;">Hi ${emp.name}, welcome to Uplift.</h1>
          <p style="font-size: 16px; line-height: 1.7; color: #5C4A3A;">Your company has set you up to receive a warm, personal message every morning before your day begins.</p>
          <p style="font-size: 16px; line-height: 1.7; color: #5C4A3A;">Take 2 minutes to personalise your experience so every message feels like it was written just for you.</p>
          <a href="${process.env.SETUP_URL || 'https://upliftau.com/setup'}?employee=${emp.id}" 
             style="display: inline-block; margin-top: 24px; background: #2D5A3D; color: white; padding: 14px 32px; border-radius: 99px; text-decoration: none; font-size: 15px;">
            Personalise my messages
          </a>
          <p style="margin-top: 40px; font-size: 13px; color: #9C8472;">The Uplift team</p>
        </div>
      `
    });
  }

  res.json({ success: true, employees: data });
});

// ─── EMPLOYEE SETUP ────────────────────────────────────────────────
app.post('/api/employee/setup', async (req, res) => {
  const { employee_id, hobbies, interests, tone, focus_areas, send_time, timezone } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'Missing employee_id' });

  await supabase.from('employees').update({ setup_complete: true, send_time, timezone }).eq('id', employee_id);

  const { error } = await supabase.from('employee_preferences').insert([{
    employee_id, hobbies, interests, tone, focus_areas
  }]);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ─── DASHBOARD ─────────────────────────────────────────────────────
app.get('/api/dashboard/:company_id', async (req, res) => {
  const { company_id } = req.params;

  const { data: company } = await supabase.from('companies').select('*').eq('id', company_id).single();
  const { data: employees } = await supabase.from('employees').select('*, employee_preferences(*)').eq('company_id', company_id);

  const setupComplete = employees?.filter(e => e.setup_complete).length || 0;
  const trialDaysLeft = Math.max(0, Math.ceil((new Date(company.trial_end) - new Date()) / (1000 * 60 * 60 * 24)));

  res.json({ company, employees, setupComplete, trialDaysLeft });
});

// ─── STRIPE CHECKOUT ───────────────────────────────────────────────
// When a company is ready to pay, this creates a Stripe Checkout Session.
// Stripe hosts the actual payment page so we never handle card details.
// We pass the company_id through as metadata so when Stripe calls back
// after payment, we know which company to mark as paying.
app.post('/api/create-checkout', async (req, res) => {
  const { company_id } = req.body;
  if (!company_id) return res.status(400).json({ error: 'Missing company_id' });

  try {
    const { data: company } = await supabase
      .from('companies')
      .select('*')
      .eq('id', company_id)
      .single();

    if (!company) return res.status(404).json({ error: 'Company not found' });

    // Work out which price tier based on employee count
    // Starter: up to 25 employees at $2/seat
    // Growth: 26-200 employees at $1.50/seat
    const employeeCount = company.employee_count || 1;
    const pricePerSeat = employeeCount <= 25 ? 200 : 150; // cents
    const totalAmount = pricePerSeat * employeeCount;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'aud',
          product_data: {
            name: `Uplift ${employeeCount <= 25 ? 'Starter' : 'Growth'} Plan`,
            description: `${employeeCount} employees x $${pricePerSeat / 100}/month each`
          },
          unit_amount: totalAmount,
          recurring: { interval: 'month' }
        },
        quantity: 1
      }],
      customer_email: company.email,
      metadata: { company_id },
      success_url: `${process.env.DASHBOARD_URL || 'https://upliftau.com/dashboard'}?company=${company_id}&payment=success`,
      cancel_url: `https://upliftau.com/billing?company=${company_id}&payment=cancelled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── STRIPE WEBHOOK ────────────────────────────────────────────────
// Stripe calls this URL after a payment event occurs.
// We verify the signature to confirm it's genuinely from Stripe,
// then handle the relevant events to update our database.
app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const session = event.data.object;

  if (event.type === 'checkout.session.completed') {
    // Payment was successful — mark company as paying so emails keep flowing
    const company_id = session.metadata?.company_id;
    if (company_id) {
      await supabase
        .from('companies')
        .update({
          is_paying: true,
          stripe_customer_id: session.customer
        })
        .eq('id', company_id);

      // Send a confirmation email to the company
      const { data: company } = await supabase
        .from('companies').select('*').eq('id', company_id).single();

      if (company) {
        try {
          await resend.emails.send({
            from: 'Uplift <hello@upliftau.com>',
            to: company.email,
            subject: 'You are all set. Welcome to Uplift.',
            html: `
              <div style="font-family: Georgia, serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; color: #161210;">
                <h1 style="font-size: 26px; margin-bottom: 16px;">Payment confirmed. Your team is covered.</h1>
                <p style="font-size: 16px; line-height: 1.7; color: #5C4A3A;">Hi ${company.name}, your subscription is now active. Your employees will keep receiving their personalised morning messages every day.</p>
                <p style="font-size: 16px; line-height: 1.7; color: #5C4A3A;">Thank you for investing in your team's mornings.</p>
                <a href="${process.env.DASHBOARD_URL || 'https://upliftau.com/dashboard'}?company=${company_id}"
                   style="display: inline-block; margin-top: 24px; background: #2D5A3D; color: white; padding: 14px 32px; border-radius: 99px; text-decoration: none; font-size: 15px;">
                  Go to my dashboard
                </a>
                <p style="margin-top: 40px; font-size: 13px; color: #9C8472;">The Uplift team</p>
              </div>
            `
          });
        } catch (emailErr) {
          console.error('Failed to send payment confirmation email:', emailErr.message);
        }
      }

      console.log(`Company ${company_id} is now a paying customer`);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    // Subscription was cancelled — stop their emails
    const customerId = session.customer;
    await supabase
      .from('companies')
      .update({ is_paying: false })
      .eq('stripe_customer_id', customerId);
    console.log(`Subscription cancelled for Stripe customer ${customerId}`);
  }

  res.json({ received: true });
});

// ─── DAILY EMAIL ENGINE ────────────────────────────────────────────
async function generateAndSendEmail(employee, preferences) {
  const tone = preferences?.tone || 'warm';
  const hobbies = preferences?.hobbies?.join(', ') || 'general interests';
  const interests = preferences?.interests?.join(', ') || 'personal growth';

  const prompts = {
    warm: `You are Uplift, a warm and human wellbeing service. Write a short, personal morning email to ${employee.name}. They enjoy ${hobbies} and are interested in ${interests}. Make it feel genuine, warm and human. Include one short motivational thought. Sign off as The Uplift team. Keep it under 150 words. No em dashes.`,
    motivational: `You are Uplift. Write a bold, energising morning message to ${employee.name} who enjoys ${hobbies}. Make it punchy and motivating. Include a powerful one line quote. Sign off as The Uplift team. Under 150 words. No em dashes.`,
    calm: `You are Uplift. Write a calm, grounding morning message to ${employee.name} who enjoys ${hobbies}. Keep it peaceful and centring. Include a gentle reflection. Sign off as The Uplift team. Under 150 words. No em dashes.`,
    fun: `You are Uplift. Write a light, fun morning message to ${employee.name} who enjoys ${hobbies}. Keep it cheerful and uplifting. Include something playful. Sign off as The Uplift team. Under 150 words. No em dashes.`
  };

  const prompt = prompts[tone] || prompts.warm;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  const emailBody = data.content[0].text;

  const day = new Date().toLocaleDateString('en-AU', { weekday: 'long' });
  const subject = `${day} morning, ${employee.name}.`;

  await resend.emails.send({
    from: 'Uplift <hello@upliftau.com>',
    to: employee.email,
    subject,
    html: `
      <div style="font-family: Georgia, serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; color: #161210;">
        <div style="border-top: 3px solid #2D5A3D; margin-bottom: 32px;"></div>
        <p style="font-size: 16px; line-height: 1.9; color: #5C4A3A; white-space: pre-wrap;">${emailBody}</p>
        <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #E8DFD0; font-size: 13px; color: #9C8472;">
          The Uplift team · hello@upliftau.com
        </div>
      </div>
    `
  });
}

// ─── RESEND INVITE ─────────────────────────────────────────────────
app.post('/api/employees/resend', async (req, res) => {
  const { employee_id, name, email } = req.body;
  if (!employee_id || !email) return res.status(400).json({ error: 'Missing fields' });
  try {
    await resend.emails.send({
      from: 'Uplift <hello@upliftau.com>',
      to: email,
      subject: `${name}, a reminder to personalise your Uplift messages`,
      html: `
        <div style="font-family: Georgia, serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; color: #161210;">
          <h1 style="font-size: 26px; margin-bottom: 16px;">Hi ${name}, just a quick nudge.</h1>
          <p style="font-size: 16px; line-height: 1.7; color: #5C4A3A;">Your company has set you up on Uplift but we are still waiting on your preferences.</p>
          <p style="font-size: 16px; line-height: 1.7; color: #5C4A3A;">It takes less than 2 minutes and makes a real difference to how your messages feel.</p>
          <a href="${process.env.SETUP_URL || 'https://upliftau.com/setup'}?employee=${employee_id}"
             style="display: inline-block; margin-top: 24px; background: #2D5A3D; color: white; padding: 14px 32px; border-radius: 99px; text-decoration: none; font-size: 15px;">
            Personalise my messages
          </a>
          <p style="margin-top: 40px; font-size: 13px; color: #9C8472;">The Uplift team</p>
        </div>
      `
    });
  } catch (emailErr) {
    console.error('Resend failed:', emailErr.message);
  }
  res.json({ success: true });
});

// ─── DELETE EMPLOYEE ───────────────────────────────────────────────
app.delete('/api/employees/:id', async (req, res) => {
  const { id } = req.params;
  await supabase.from('employee_preferences').delete().eq('employee_id', id);
  const { error } = await supabase.from('employees').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ─── TEST EMAIL ────────────────────────────────────────────────────
app.post('/api/test-email/:employee_id', async (req, res) => {
  const { employee_id } = req.params;
  const { data: employee } = await supabase
    .from('employees')
    .select('*, employee_preferences(*)')
    .eq('id', employee_id)
    .single();
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  const prefs = employee.employee_preferences?.[0];
  try {
    await generateAndSendEmail(employee, prefs);
    res.json({ success: true, message: `Test email sent to ${employee.email}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CRON SCHEDULER ────────────────────────────────────────────────
// Runs every minute. For each employee we convert the current UTC time
// into THEIR local timezone before comparing against their chosen send_time.
// This is critical because Render servers run on UTC — without this fix,
// an Australian employee who picks 9:00 AM would get their email at 7:00 PM.
cron.schedule('* * * * *', async () => {
  const now = new Date();

  const { data: employees } = await supabase
    .from('employees')
    .select('*, employee_preferences(*), companies(is_paying, trial_end)')
    .eq('setup_complete', true);

  if (!employees?.length) return;

  for (const employee of employees) {
    const company = employee.companies;
    const trialActive = new Date(company.trial_end) > now;
    if (!company.is_paying && !trialActive) continue;

    // Convert current UTC time to the employee's local timezone
    const timezone = employee.timezone || 'Australia/Sydney';
    const localTime = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    const h = localTime.getHours();
    const m = localTime.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    const currentLocalTime = `${h12}:${String(m).padStart(2,'0')} ${ampm}`;

    if (employee.send_time !== currentLocalTime) continue;

    const prefs = employee.employee_preferences?.[0];
    try {
      await generateAndSendEmail(employee, prefs);
      console.log(`Email sent to ${employee.email} at ${currentLocalTime} ${timezone}`);
    } catch (err) {
      console.error(`Failed to send to ${employee.email}:`, err.message);
    }
  }
});

// ─── TRIAL REMINDER ────────────────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
  const twoDaysFromNow = new Date();
  twoDaysFromNow.setDate(twoDaysFromNow.getDate() + 2);
  const dateStr = twoDaysFromNow.toISOString().split('T')[0];

  const { data: companies } = await supabase
    .from('companies')
    .select('*')
    .eq('is_paying', false)
    .like('trial_end', `${dateStr}%`);

  for (const company of companies || []) {
    await resend.emails.send({
      from: 'Uplift <hello@upliftau.com>',
      to: company.email,
      subject: 'Your Uplift trial ends in 2 days',
      html: `
        <div style="font-family: Georgia, serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; color: #161210;">
          <h2 style="font-size: 24px;">Your free trial ends in 2 days</h2>
          <p style="font-size: 16px; line-height: 1.7; color: #5C4A3A;">Hi ${company.name}, your team has been receiving their daily Uplift messages and we hope it has made a difference.</p>
          <p style="font-size: 16px; line-height: 1.7; color: #5C4A3A;">To keep the messages going, add your payment details before your trial ends.</p>
          <a href="https://upliftau.com/billing?company=${company.id}" 
             style="display: inline-block; margin-top: 24px; background: #2D5A3D; color: white; padding: 14px 32px; border-radius: 99px; text-decoration: none; font-size: 15px;">
            Continue with Uplift
          </a>
          <p style="margin-top: 40px; font-size: 13px; color: #9C8472;">The Uplift team</p>
        </div>
      `
    });
  }
});

app.get('/', (req, res) => res.json({ status: 'Uplift backend running' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Uplift backend running on port ${PORT}`));
