import { h } from '../ui.js';
import { pageHead } from './common.js';

export function render() {
  const sec = (title, ...body) => h('section.card.prose', h('h2', title), ...body);
  return h('div.page.guide',
    pageHead('Guide', 'How to get reliable results from SickleScan Lab.'),
    sec('Workflow',
      h('ol',
        h('li', h('strong', 'Register the patient'), ' with a coded ID (for example SC-0001). Record the genotype only if it was confirmed by HPLC or electrophoresis, and the hydroxyurea start date if relevant.'),
        h('li', h('strong', 'Start a new analysis'), ' and fill in the sample date, stain, magnification and your initials.'),
        h('li', h('strong', 'Add 5–10 field images'), ' from the thin monolayer area of the smear. Each field is analysed on this device in about a second.'),
        h('li', h('strong', 'Review each field.'), ' Click any cell to see its measurements. Correct mistakes with the buttons or the keys N (normal), B (borderline), S (sickled), X (exclude) and R (reset).'),
        h('li', h('strong', 'Finalise'), ' to produce the report. Print it or save it as PDF from the print dialog.'),
        h('li', h('strong', 'Repeat over time.'), ' The patient page charts every reported slide, with the hydroxyurea start marked.'))),
    sec('Taking good field images',
      h('ul',
        h('li', 'Use the feathered edge to body transition, where cells touch but do not overlap.'),
        h('li', '40× to 100× objective. Focus carefully and keep lighting even across the field.'),
        h('li', 'Aim for at least 200 cells per slide in total (the QC minimum is set in Settings).'),
        h('li', 'Phone photos through the eyepiece work. Fill the frame with the field and avoid the dark ring around it, or crop it first.'),
        h('li', 'If cells appear lighter than the background (some stains or phase contrast), tick “Cells lighter than background”.'))),
    sec('Reading the numbers',
      h('p', h('strong', '% sickled'), ' is sickled ÷ (normal + borderline + sickled), pooled over all included fields. Clumps, edge cells and cells you exclude are not counted.'),
      h('p', h('strong', 'The 95% interval'), ' shows how precise the percentage is. It narrows as more cells are counted: with 100 cells and 10% sickled it is about 6–17%; with 500 cells it is about 8–13%.'),
      h('p', h('strong', 'Borderline'), ' cells are elongated but not clearly sickled (for example elliptocytes, or cells distorted while drying). Review them and correct where needed.'),
      h('p', h('strong', 'Bands'), ' (occasional, moderate, high) describe the fraction only. They are not clinical categories.')),
    sec('Privacy and storage',
      h('p', 'All patients, slides and images are stored in this browser on this computer. Nothing is uploaded to a server. There are no accounts.'),
      h('p', 'This means data does not follow you to another computer, and clearing your browser data deletes it. Export a backup from Settings regularly. Never enter names, phone numbers, addresses or hospital numbers.')),
    sec('Limits',
      h('ul',
        h('li', 'SickleScan measures cell shape. It cannot tell sickled cells from every other elongated form, and it does not detect haemoglobin type.'),
        h('li', 'It is a research and teaching tool, not a medical device. Diagnosis needs HPLC, haemoglobin electrophoresis or another validated test, read by a qualified clinician.'),
        h('li', 'Overlapping cells are excluded rather than split, so very dense fields under-count.'))));
}
