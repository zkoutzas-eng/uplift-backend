require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

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
  try {
    const { company_id } = req.params;

    const { data: company, error: companyError } = await supabase
      .from('companies').select('*').eq('id', company_id).single();

    if (companyError || !company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const { data: employees } = await supabase
      .from('employees')
      .select('*, employee_preferences(*)')
      .eq('company_id', company_id);

    const setupComplete = (employees || []).filter(e => e.setup_complete).length;

    let trialDaysLeft = 14;
    if (company.trial_end) {
      trialDaysLeft = Math.max(0, Math.ceil((new Date(company.trial_end) - new Date()) / (1000 * 60 * 60 * 24)));
    }

    res.json({ company, employees: employees || [], setupComplete, trialDaysLeft });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── RESEND INVITE ─────────────────────────────────────────────────
app.post('/api/employees/resend', async (req, res) => {
  const { employee_id, name, email } = req.body;
  if (!employee_id || !email) return res.status(400).json({ error: 'Missing fields' });

  await resend.emails.send({
    from: 'Uplift <hello@upliftau.com>',
    to: email,
    subject: `${name}, a reminder to personalise your Uplift messages`,
    html: `
      <div style="font-family: Georgia, serif; max-width: 560px; margin: 0 auto; padding: 40px 20px; color: #161210;">
        <h1 style="font-size: 26px; margin-bottom: 16px;">Hi ${name}, just a quick nudge.</h1>
        <p style="font-size: 16px; line-height: 1.7; color: #5C4A3A;">Your company has set you up on Uplift but we are still waiting on your preferences so we can personalise your morning messages.</p>
        <p style="font-size: 16px; line-height: 1.7; color: #5C4A3A;">It takes less than 2 minutes and makes a real difference to how your messages feel.</p>
        <a href="${process.env.SETUP_URL || 'https://upliftau.com/setup'}?employee=${employee_id}"
           style="display: inline-block; margin-top: 24px; background: #2D5A3D; color: white; padding: 14px 32px; border-radius: 99px; text-decoration: none; font-size: 15px;">
          Personalise my messages
        </a>
        <p style="margin-top: 40px; font-size: 13px; color: #9C8472;">The Uplift team</p>
      </div>
    `
  });

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

// ─── CRON SCHEDULER ────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const currentTime = `${h12}:${String(m).padStart(2,'0')} ${ampm}`;

  const { data: employees } = await supabase
    .from('employees')
    .select('*, employee_preferences(*), companies(is_paying, trial_end)')
    .eq('setup_complete', true)
    .eq('send_time', currentTime);

  if (!employees?.length) return;

  for (const employee of employees) {
    const company = employee.companies;
    const trialActive = new Date(company.trial_end) > now;
    if (!company.is_paying && !trialActive) continue;
    const prefs = employee.employee_preferences?.[0];
    await generateAndSendEmail(employee, prefs);
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
