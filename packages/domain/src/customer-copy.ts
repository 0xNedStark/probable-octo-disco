import type { MainStage, Stage } from './stages';

/** Customer-facing wording for each step; internal stage names never reach customers. */
export const CUSTOMER_STEPS: { stage: MainStage; title: string; next: string }[] = [
  {
    stage: 'LEAD',
    title: 'Enquiry received',
    next: 'Share your latest electricity bill so we can size your system.',
  },
  { stage: 'QUALIFIED', title: 'Bill checked', next: 'We are preparing your proposal.' },
  {
    stage: 'QUOTED',
    title: 'Proposal sent',
    next: 'Review your proposal and accept it to book a free site survey.',
  },
  { stage: 'BOOKED', title: 'Booked', next: 'We will call you to schedule the site survey.' },
  {
    stage: 'SURVEYED',
    title: 'Site survey done',
    next: 'Our engineer is finalising your system design.',
  },
  {
    stage: 'DESIGN_APPROVED',
    title: 'Design approved',
    next: 'We are arranging DVVNL approval, finance and materials.',
  },
  {
    stage: 'READY_TO_INSTALL',
    title: 'Ready to install',
    next: 'Our installation team will confirm a date with you.',
  },
  {
    stage: 'INSTALLED',
    title: 'Installed',
    next: 'Quality check of your installation is under way.',
  },
  {
    stage: 'QA_PASSED',
    title: 'Quality checked',
    next: 'Waiting for DVVNL inspection and net meter.',
  },
  {
    stage: 'COMMISSIONED',
    title: 'Switched on',
    next: 'We are preparing your handover documents.',
  },
  {
    stage: 'HANDED_OVER',
    title: 'Handed over',
    next: 'Your subsidy is being processed; we will keep you updated.',
  },
  {
    stage: 'CLOSED',
    title: 'Complete',
    next: 'Enjoy your solar power! Message us anytime for support.',
  },
];

export const SIDE_STAGE_COPY: Partial<Record<Stage, string>> = {
  ON_HOLD: 'Your project is paused. We will contact you before resuming.',
  CANCELLED: 'This project was cancelled. Contact us if this is unexpected.',
  LOST: 'This enquiry is closed. Message us anytime to restart.',
};

export const FINANCE_COPY: Record<string, string | null> = {
  UNDECIDED: null,
  NOT_REQUIRED: 'Paying in full',
  DOCS_PENDING: 'Loan: gathering documents',
  SUBMITTED: 'Loan: application submitted to the bank',
  SANCTIONED: 'Loan: sanctioned by the bank',
  REJECTED: 'Loan: not approved — our team will discuss options with you',
  DISBURSED: 'Loan: disbursed',
};

export const REGULATORY_COPY: Record<string, string | null> = {
  NOT_STARTED: null,
  PORTAL_REGISTERED: 'Registered on the PM Surya Ghar portal',
  FEASIBILITY_SUBMITTED: 'DVVNL feasibility requested',
  FEASIBILITY_REJECTED: 'DVVNL asked for changes; we are resubmitting',
  FEASIBILITY_APPROVED: 'DVVNL feasibility approved',
  INSTALLATION_DETAILS_UPLOADED: 'Installation details submitted to the portal',
  NET_METER_INSTALLED: 'Net meter installed',
  INSPECTED: 'DVVNL inspection done',
  COMMISSIONED: 'Commissioned by DVVNL',
  SUBSIDY_CLAIMED: 'Subsidy claim filed',
  SUBSIDY_RELEASED: 'Subsidy credited to your bank account',
};
