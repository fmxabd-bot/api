const id={name:'id',in:'path',default:'6207982430134357800',required:true};
const page={name:'page',in:'query',default:'1'};
const perPage={name:'perPage',in:'query',default:'20'};
const query={name:'query',in:'path',default:'Breaking Bad',required:true};
const se={name:'season',in:'query',default:'1'};
const ep={name:'episode',in:'query',default:'1'};
const route=(group,path,description,params=[])=>({group,method:'GET',path:'/api/v3'+path,description,params});
export const catalog=[
    route('Status','/health','Service health and storage configuration. No key required.'),
    route('Discovery','/homepage','Current MovieBox homepage sections.'),
    route('Discovery','/trending','Current homepage titles, deduplicated and paginated.',[page,perPage,{name:'type',in:'query',default:'0'}]),
    route('Discovery','/search/:query','Search MovieBox titles.',[query,page,perPage]),
    route('Discovery','/filter','Filter the MovieBox catalog.',[page,perPage,{name:'type',in:'query',default:'1'},{name:'genre',in:'query',default:'ALL'},{name:'country',in:'query',default:'ALL'},{name:'year',in:'query',default:'ALL'},{name:'language',in:'query',default:'ALL'}]),
    route('Titles & episodes','/info/:id','Title metadata, cast, resource and season information.',[id]),
    route('Titles & episodes','/episodes/:id','Available seasons and episode numbers. Missing titles or descriptions are null, never invented.',[id]),
    route('Titles & episodes','/season/:id/:season','One season with the series title.',[id,{name:'season',in:'path',default:'1',required:true}]),
    route('Streaming','/sources/:id','Short playback/download URLs with no API key in them, available qualities and descriptive filenames. Links expire after six hours. The best MP4 is also available as streamUrl and downloadUrl.',[id,se,ep]),
    route('Streaming','/captions/:subjectId/:streamId','Subtitle tracks for a source ID.',[{...id,name:'subjectId'},{name:'streamId',in:'path',required:true,default:''},{name:'format',in:'query',default:''}]),
    route('Streaming','/stream/:token','Open the short playback URL returned by /sources. No API key in the URL. Supports Range and HEAD; playback does not consume extra quota.',[{name:'token',in:'path',default:'',required:true}]),
    route('Streaming','/download/:token','Open the download URL from /sources. Uses the title, season/episode, quality and DaraTech filename without exposing API keys.',[{name:'token',in:'path',default:'',required:true}]),
    route('Anime','/anime','Anime titles from MovieBox homepage sections.',[page,perPage]),
    route('Anime','/anime/search/:query','Search titles restricted to the Animation/Anime genre.',[query,page,perPage]),
    route('Anime','/anime/info/:id','Title metadata with anime genre validation.',[{...id,default:'2938891905879310568'}]),
    route('Anime','/anime/sources/:id','Anime playback and download proxy URLs.',[{...id,default:'2938891905879310568'},se,ep]),
    route('Football','/football','Football fixtures scraped directly from MovieBox; no IPTV or unrelated sports.'),
    route('Football','/football/:id','Current match details.',[{...id,default:'2994851809161895200'}]),
    route('Football','/football/:id/sources','MovieBox football HLS sources through the signed proxy.',[{...id,default:'2994851809161895200'}]),
    ...[
        ['/manga/home','Manga homepage',[]],['/manga/search','Search manga',[{name:'q',in:'query',default:'solo',required:true}]],
        ['/manga/genres','Manga genres',[]],['/manga/popular','Popular manga',[page]],['/manga/latest','Latest manga',[page]],
        ['/manga/genre/:slug','Manga by genre',[{name:'slug',in:'path',default:'action',required:true},page]],
        ['/manga/browse','Browse manga',[page]],['/manga/details/:slug','Manga detail and chapter list',[{name:'slug',in:'path',default:'solo-leveling',required:true}]],
        ['/manga/chapter/:slug','Chapter image URLs',[{name:'slug',in:'path',default:'',required:true}]],
        ['/manga/chapter/:slug/download','Chapter ZIP download',[{name:'slug',in:'path',default:'',required:true}]],
        ['/manga/download/:slug','Chapter range ZIP download',[{name:'slug',in:'path',default:'',required:true},{name:'from',in:'query',default:'1'},{name:'to',in:'query',default:'2'}]]
    ].map(([p,d,params])=>route('Manga',p,d,params))
];
