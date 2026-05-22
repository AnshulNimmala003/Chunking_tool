const MOCK_BOXES = [
  { type: 'header',      title: 'Document Title / Header',         summary: 'Full-width heading with document title, subtitle, and date range metadata.', text_content: 'Q3 2024 Executive Performance Dashboard\nReporting Period: July – September 2024', box: [0.02, 0.02, 0.12, 0.98] },
  { type: 'chart',       title: 'Quarterly Sales Bar Chart',        summary: 'Grouped bar chart comparing quarterly sales performance by product line across four quarters.', text_content: 'Sales by Quarter\nQ1: $1.2M  Q2: $1.5M  Q3: $1.8M  Q4: $1.4M', box: [0.15, 0.02, 0.54, 0.49] },
  { type: 'chart',       title: 'Monthly Revenue Trend Line Chart', summary: 'Line chart showing monthly revenue over the past 12 months with YoY comparison overlay.', text_content: 'Monthly Revenue Trend\nJan $320K · Feb $280K · Mar $410K · Apr $390K', box: [0.15, 0.51, 0.54, 0.98] },
  { type: 'table',       title: 'Regional KPI Breakdown Table',     summary: 'Tabular breakdown of 8 KPIs with actual vs. target values and variance by region.', text_content: 'Region | Actual | Target | Var\nNorth | $2.1M | $2.0M | +5%\nSouth | $1.8M | $2.0M | -10%', box: [0.57, 0.02, 0.78, 0.98] },
  { type: 'infographic', title: 'Total Revenue KPI Card',           summary: 'Highlighted metric card showing total revenue of $4.2M with +12% YoY growth indicator.', text_content: 'Total Revenue\n$4.2M\n▲ +12% YoY', box: [0.81, 0.02, 0.98, 0.32] },
  { type: 'text',        title: 'Executive Summary',                summary: 'Narrative text block summarising key findings and strategic recommendations.', text_content: 'Q3 performance exceeded targets driven by North region growth.', box: [0.81, 0.34, 0.98, 0.98] }
];

function toFilename(title) {
  return (title || 'chunk')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'chunk';
}

module.exports = { MOCK_BOXES, toFilename };
