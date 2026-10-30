// Public business support contact, shared by request and upgrade flows.
export const whatsApp=message=>'https://wa.me/2348100785677?text='+encodeURIComponent(message);
export const upgradeContact=reason=>whatsApp(
    `Hi, I need help with my RUNFLIX MovieAPI key${reason?' ('+reason+')':''}. Please help me upgrade or review my access.`);
export const keyContact=(key,reason)=>!key||key==='daratechapi'
    ?{contact:'/request-key',contactAction:'request_key',contactLabel:'Request your own key',
        hint:'Request your own API key for dedicated limits.'}
    :{contact:upgradeContact(reason),contactAction:'upgrade',contactLabel:'Upgrade on WhatsApp',
        hint:'For limit increases, renewals or other key upgrades, message support on WhatsApp.'};
export const requestContact=(request,id)=>whatsApp(
    `New RUNFLIX MovieAPI key request\nReference: ${id}\nName: ${request.name}\nEmail: ${request.email||'—'}\nPhone: ${request.phone||'—'}\nWebsite: ${request.website||'—'}\nUse case: ${request.useCase}`);
