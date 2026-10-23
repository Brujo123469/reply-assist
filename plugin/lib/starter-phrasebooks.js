// Starter phrasebooks, so the phrasebook answers common travel exchanges from
// the first conversation without any Claude calls. "Build phrasebook" adds
// situation-specific phrases on top, and conversations add more.
//
// Each pair has:
//   bank:    10 universal replies, in the fixed order session.js relies on
//            (yes, no, don't understand, repeat, slower, one moment, thanks,
//            sorry, don't know, okay)
//   phrases: [what they say, its meaning, reply, reply, reply]
//            reply = [text, meaning] or, for other scripts, [text, reading, meaning]
//
// Japanese readings are plain-ASCII romaji (ou/uu for long vowels): the
// glasses font may not have macrons.

const reply = (r) => (r.length === 3
  ? { text: r[0], reading: r[1], gloss: r[2] }
  : { text: r[0], gloss: r[1] });

function build({ bank, phrases }) {
  return {
    bank: bank.map((r) => ({ ...reply(r), source: 'bank' })),
    phrases: phrases.map(([q, t, ...replies]) => ({ q, t, replies: replies.map(reply), source: 'starter' })),
  };
}

const es = {
  bank: [
    ['Sí', 'yes'], ['No', 'no'], ['No entiendo', 'I don\'t understand'],
    ['¿Puede repetir?', 'could you repeat that?'], ['Más despacio, por favor', 'more slowly, please'],
    ['Un momento', 'one moment'], ['Gracias', 'thank you'], ['Perdón', 'sorry'],
    ['No sé', 'I don\'t know'], ['Vale, perfecto', 'okay, sounds good'],
  ],
  phrases: [
    // Greetings and small talk
    ['Hola, ¿qué tal?', 'Hi, how are you?', ['Muy bien, gracias. ¿Y usted?', 'very well, thanks. And you?'], ['Bien, un poco cansado', 'fine, a bit tired'], ['Hola, encantado', 'hi, nice to meet you']],
    ['¿Cómo está?', 'How are you?', ['Muy bien, gracias', 'very well, thanks'], ['Bien, ¿y usted?', 'fine, and you?'], ['Cansado del viaje', 'tired from the trip']],
    ['Encantado de conocerle', 'Nice to meet you', ['Igualmente', 'likewise'], ['Un placer', 'a pleasure'], ['El gusto es mío', 'the pleasure is mine']],
    ['¿De dónde es?', 'Where are you from?', ['Soy de Estados Unidos', 'I\'m from the United States'], ['De Estados Unidos, ¿y usted?', 'from the US, and you?'], ['Adivine', 'guess']],
    ['¿Es su primera vez aquí?', 'Is this your first time here?', ['Sí, es mi primera vez', 'yes, it\'s my first time'], ['No, ya vine antes', 'no, I\'ve been before'], ['Sí, ¿qué me recomienda?', 'yes, what do you recommend?']],
    ['¿Habla español?', 'Do you speak Spanish?', ['Un poquito', 'a little bit'], ['Estoy aprendiendo', 'I\'m learning'], ['¿Habla inglés?', 'do you speak English?']],
    ['¿Cuánto tiempo se queda?', 'How long are you staying?', ['Una semana', 'a week'], ['Unos días', 'a few days'], ['Hasta el viernes', 'until Friday']],
    ['¿Le gusta la ciudad?', 'Do you like the city?', ['Me encanta', 'I love it'], ['Sí, es muy bonita', 'yes, it\'s very pretty'], ['Acabo de llegar', 'I just arrived']],
    ['¿A qué se dedica?', 'What do you do for work?', ['Trabajo en tecnología', 'I work in tech'], ['Estoy de vacaciones', 'I\'m on vacation'], ['¿Y usted?', 'and you?']],
    ['Que tenga un buen día', 'Have a nice day', ['Igualmente', 'you too'], ['Gracias, adiós', 'thanks, bye'], ['Hasta luego', 'see you later']],
    // Hotel
    ['¿En qué le puedo ayudar?', 'How can I help you?', ['Tengo una reserva', 'I have a reservation'], ['Busco una habitación', 'I\'m looking for a room'], ['Solo estoy mirando', 'I\'m just looking']],
    ['¿Tiene una reserva?', 'Do you have a reservation?', ['Sí, a mi nombre', 'yes, under my name'], ['No, no tengo', 'no, I don\'t'], ['¿Hay habitaciones libres?', 'are there rooms available?']],
    ['¿Me deja su pasaporte, por favor?', 'May I have your passport, please?', ['Sí, aquí tiene', 'yes, here you go'], ['Un momento, por favor', 'one moment, please'], ['¿Le sirve una foto?', 'will a photo do?']],
    ['¿Cuántas noches se queda?', 'How many nights are you staying?', ['Tres noches', 'three nights'], ['Solo esta noche', 'just tonight'], ['Todavía no lo sé', 'I don\'t know yet']],
    ['¿Para cuántas personas?', 'For how many people?', ['Para dos', 'for two'], ['Solo para mí', 'just for me'], ['Somos cuatro', 'there are four of us']],
    ['¿Quiere el desayuno incluido?', 'Would you like breakfast included?', ['Sí, por favor', 'yes, please'], ['No, gracias', 'no, thanks'], ['¿Cuánto cuesta?', 'how much is it?']],
    ['El desayuno es de siete a diez', 'Breakfast is from seven to ten', ['Perfecto, gracias', 'perfect, thanks'], ['¿Dónde se sirve?', 'where is it served?'], ['¿A qué hora es la salida?', 'what time is checkout?']],
    ['Su habitación está en el tercer piso', 'Your room is on the third floor', ['¿Hay ascensor?', 'is there an elevator?'], ['Muchas gracias', 'thank you very much'], ['¿Cuál es la contraseña del wifi?', 'what\'s the wifi password?']],
    ['La salida es a las doce', 'Checkout is at twelve', ['Perfecto', 'perfect'], ['¿Puedo salir más tarde?', 'can I check out later?'], ['¿Me guardan la maleta?', 'can you hold my suitcase?']],
    ['¿Le ayudo con la maleta?', 'Can I help you with your suitcase?', ['Sí, muchas gracias', 'yes, thank you very much'], ['No hace falta, gracias', 'no need, thanks'], ['Con cuidado, por favor', 'carefully, please']],
    // Restaurant and café
    ['¿Tiene mesa reservada?', 'Do you have a table booked?', ['Sí, a mi nombre', 'yes, under my name'], ['No, ¿hay sitio?', 'no, is there room?'], ['Somos dos', 'there are two of us']],
    ['¿Qué le pongo?', 'What can I get you?', ['Un café con leche, por favor', 'a latte, please'], ['¿Qué me recomienda?', 'what do you recommend?'], ['Todavía estoy mirando', 'I\'m still looking']],
    ['¿Qué van a tomar?', 'What will you have?', ['La carta, por favor', 'the menu, please'], ['Agua para todos', 'water for everyone'], ['Un momento, por favor', 'one moment, please']],
    ['¿Quiere algo de beber?', 'Would you like something to drink?', ['Un agua, por favor', 'a water, please'], ['Una cerveza', 'a beer'], ['No, gracias', 'no, thanks']],
    ['¿Ya saben qué van a pedir?', 'Do you know what you\'d like to order?', ['Sí, yo quiero esto', 'yes, I\'ll have this'], ['Necesitamos unos minutos', 'we need a few minutes'], ['¿Qué nos recomienda?', 'what do you recommend?']],
    ['¿Todo bien?', 'Is everything okay?', ['Todo muy rico', 'everything is delicious'], ['Sí, gracias', 'yes, thanks'], ['¿Me trae más pan?', 'could you bring more bread?']],
    ['¿Quiere postre?', 'Would you like dessert?', ['¿Qué tienen?', 'what do you have?'], ['No, gracias, estoy lleno', 'no thanks, I\'m full'], ['Solo un café', 'just a coffee']],
    ['¿Algo más?', 'Anything else?', ['No, eso es todo', 'no, that\'s all'], ['La cuenta, por favor', 'the check, please'], ['Un café, por favor', 'a coffee, please']],
    ['¿Para tomar aquí o para llevar?', 'For here or to go?', ['Para tomar aquí', 'for here'], ['Para llevar', 'to go'], ['¿Hay mesa libre?', 'is there a free table?']],
    // Shops and paying
    ['¿Le puedo ayudar en algo?', 'Can I help you with anything?', ['Solo estoy mirando, gracias', 'just looking, thanks'], ['Busco una talla mediana', 'I\'m looking for a medium'], ['¿Cuánto cuesta esto?', 'how much is this?']],
    ['¿Qué talla usa?', 'What size do you wear?', ['Mediana', 'medium'], ['No estoy seguro', 'I\'m not sure'], ['¿Me lo puedo probar?', 'can I try it on?']],
    ['¿Paga con tarjeta o en efectivo?', 'Are you paying by card or cash?', ['Con tarjeta', 'by card'], ['En efectivo', 'in cash'], ['¿Puedo pagar con el móvil?', 'can I pay with my phone?']],
    ['Son veinte euros', 'That\'s twenty euros', ['Aquí tiene', 'here you are'], ['¿Acepta tarjeta?', 'do you take cards?'], ['¿Me hace un descuento?', 'can you give me a discount?']],
    ['¿Quiere una bolsa?', 'Would you like a bag?', ['Sí, por favor', 'yes, please'], ['No, gracias', 'no, thanks'], ['¿Cuánto cuesta la bolsa?', 'how much is the bag?']],
    ['¿Quiere el ticket?', 'Would you like the receipt?', ['Sí, por favor', 'yes, please'], ['No, gracias', 'no, thanks'], ['¿Me lo manda por correo?', 'can you email it to me?']],
    // Getting around
    ['¿Adónde va?', 'Where are you going?', ['Al centro, por favor', 'downtown, please'], ['A esta dirección', 'to this address'], ['Al aeropuerto', 'to the airport']],
    ['¿Está buscando algo?', 'Are you looking for something?', ['Busco la estación de metro', 'I\'m looking for the metro station'], ['Sí, ¿dónde está el baño?', 'yes, where is the bathroom?'], ['No, gracias', 'no, thanks']],
    ['Siga recto y luego a la derecha', 'Go straight and then right', ['Muchas gracias', 'thank you very much'], ['¿Está lejos?', 'is it far?'], ['¿Me lo enseña en el mapa?', 'could you show me on the map?']],
    ['Está a cinco minutos andando', 'It\'s a five-minute walk', ['Perfecto, gracias', 'perfect, thanks'], ['¿Por dónde?', 'which way?'], ['¿Hay autobús?', 'is there a bus?']],
    ['¿Necesita algo más?', 'Do you need anything else?', ['No, eso es todo', 'no, that\'s all'], ['Sí, una cosa más', 'yes, one more thing'], ['¿Me puede llamar un taxi?', 'can you call me a taxi?']],
  ],
};

const ja = {
  bank: [
    ['はい', 'hai', 'yes'], ['いいえ', 'iie', 'no'], ['わかりません', 'wakarimasen', 'I don\'t understand'],
    ['もう一度お願いします', 'mou ichido onegaishimasu', 'once more, please'], ['ゆっくりお願いします', 'yukkuri onegaishimasu', 'slowly, please'],
    ['ちょっと待ってください', 'chotto matte kudasai', 'one moment, please'], ['ありがとうございます', 'arigatou gozaimasu', 'thank you'],
    ['すみません', 'sumimasen', 'sorry / excuse me'], ['知りません', 'shirimasen', 'I don\'t know'], ['大丈夫です', 'daijoubu desu', 'okay, that\'s fine'],
  ],
  phrases: [
    // Greetings and small talk
    ['こんにちは', 'Hello', ['こんにちは', 'konnichiwa', 'hello'], ['こんにちは、お元気ですか', 'konnichiwa, ogenki desu ka', 'hello, how are you?'], ['すみません、英語は話せますか', 'sumimasen, eigo wa hanasemasu ka', 'do you speak English?']],
    ['お元気ですか？', 'How are you?', ['元気です。あなたは？', 'genki desu. anata wa?', 'I\'m well. And you?'], ['はい、元気です', 'hai, genki desu', 'yes, I\'m well'], ['ちょっと疲れています', 'chotto tsukarete imasu', 'I\'m a bit tired']],
    ['はじめまして', 'Nice to meet you', ['はじめまして、よろしくお願いします', 'hajimemashite, yoroshiku onegaishimasu', 'nice to meet you'], ['こちらこそ', 'kochira koso', 'likewise'], ['お会いできてうれしいです', 'oai dekite ureshii desu', 'I\'m glad to meet you']],
    ['どこから来ましたか？', 'Where are you from?', ['アメリカから来ました', 'amerika kara kimashita', 'I\'m from America'], ['アメリカです。あなたは？', 'amerika desu. anata wa?', 'America. And you?'], ['当ててみてください', 'atete mite kudasai', 'guess']],
    ['日本は初めてですか？', 'Is this your first time in Japan?', ['はい、初めてです', 'hai, hajimete desu', 'yes, it\'s my first time'], ['いいえ、二回目です', 'iie, nikaime desu', 'no, it\'s my second time'], ['はい、おすすめはありますか', 'hai, osusume wa arimasu ka', 'yes, any recommendations?']],
    ['日本語が上手ですね', 'Your Japanese is good', ['ありがとうございます', 'arigatou gozaimasu', 'thank you'], ['まだまだです', 'mada mada desu', 'I still have a long way to go'], ['勉強中です', 'benkyou chuu desu', 'I\'m studying it']],
    ['日本語を話せますか？', 'Can you speak Japanese?', ['少しだけ', 'sukoshi dake', 'just a little'], ['勉強中です', 'benkyou chuu desu', 'I\'m learning'], ['英語は話せますか', 'eigo wa hanasemasu ka', 'do you speak English?']],
    ['どのくらい日本にいますか？', 'How long are you in Japan?', ['一週間です', 'isshuukan desu', 'one week'], ['数日だけです', 'suujitsu dake desu', 'just a few days'], ['金曜日までです', 'kinyoubi made desu', 'until Friday']],
    ['日本はどうですか？', 'How do you like Japan?', ['とても楽しいです', 'totemo tanoshii desu', 'it\'s really fun'], ['食べ物がおいしいです', 'tabemono ga oishii desu', 'the food is delicious'], ['まだ来たばかりです', 'mada kita bakari desu', 'I just arrived']],
    ['お仕事は何ですか？', 'What do you do for work?', ['ITの仕事です', 'aitii no shigoto desu', 'I work in IT'], ['今は旅行中です', 'ima wa ryokou chuu desu', 'I\'m traveling right now'], ['あなたは？', 'anata wa?', 'and you?']],
    ['ありがとうございました', 'Thank you very much', ['こちらこそ', 'kochira koso', 'thank you too'], ['どういたしまして', 'dou itashimashite', 'you\'re welcome'], ['また来ます', 'mata kimasu', 'I\'ll come again']],
    // Hotel
    ['ご予約はありますか？', 'Do you have a reservation?', ['はい、あります', 'hai, arimasu', 'yes, I do'], ['いいえ、ありません', 'iie, arimasen', 'no, I don\'t'], ['空いている部屋はありますか', 'aite iru heya wa arimasu ka', 'are there rooms available?']],
    ['パスポートをお願いします', 'Your passport, please', ['はい、どうぞ', 'hai, douzo', 'here you go'], ['少々お待ちください', 'shoushou omachi kudasai', 'one moment, please'], ['コピーでもいいですか', 'kopii demo ii desu ka', 'is a copy okay?']],
    ['何泊されますか？', 'How many nights are you staying?', ['三泊です', 'sanpaku desu', 'three nights'], ['一泊だけです', 'ippaku dake desu', 'just one night'], ['まだわかりません', 'mada wakarimasen', 'I don\'t know yet']],
    ['朝食はお付けしますか？', 'Would you like breakfast included?', ['はい、お願いします', 'hai, onegaishimasu', 'yes, please'], ['いいえ、結構です', 'iie, kekkou desu', 'no, thank you'], ['いくらですか', 'ikura desu ka', 'how much is it?']],
    ['お部屋は五階です', 'Your room is on the fifth floor', ['エレベーターはどこですか', 'erebeetaa wa doko desu ka', 'where is the elevator?'], ['ありがとうございます', 'arigatou gozaimasu', 'thank you'], ['Wi-Fiのパスワードは？', 'waifai no pasuwaado wa?', 'the wifi password?']],
    ['チェックアウトは十一時です', 'Checkout is at eleven', ['わかりました', 'wakarimashita', 'understood'], ['遅くできますか', 'osoku dekimasu ka', 'can it be later?'], ['荷物を預けられますか', 'nimotsu o azukeraremasu ka', 'can I leave my luggage?']],
    ['少々お待ちください', 'Please wait a moment', ['はい', 'hai', 'okay'], ['大丈夫です', 'daijoubu desu', 'no problem'], ['どのくらいかかりますか', 'dono kurai kakarimasu ka', 'how long will it take?']],
    // Restaurant and café
    ['いらっしゃいませ', 'Welcome', ['こんにちは', 'konnichiwa', 'hello'], ['見ているだけです', 'mite iru dake desu', 'I\'m just looking'], ['予約しています', 'yoyaku shite imasu', 'I have a reservation']],
    ['何名様ですか？', 'How many people?', ['二人です', 'futari desu', 'two people'], ['一人です', 'hitori desu', 'just one'], ['四人です', 'yonin desu', 'four people']],
    ['ご注文はお決まりですか？', 'Are you ready to order?', ['これをお願いします', 'kore o onegaishimasu', 'this one, please'], ['もう少し待ってください', 'mou sukoshi matte kudasai', 'please wait a little'], ['おすすめは何ですか', 'osusume wa nan desu ka', 'what do you recommend?']],
    ['お飲み物はいかがですか？', 'Would you like something to drink?', ['お水をください', 'omizu o kudasai', 'water, please'], ['ビールをお願いします', 'biiru o onegaishimasu', 'a beer, please'], ['大丈夫です', 'daijoubu desu', 'I\'m fine']],
    ['辛いのは大丈夫ですか？', 'Are you okay with spicy food?', ['はい、大丈夫です', 'hai, daijoubu desu', 'yes, that\'s fine'], ['少しなら大丈夫です', 'sukoshi nara daijoubu desu', 'a little is fine'], ['辛いのは苦手です', 'karai no wa nigate desu', 'I\'m not good with spicy']],
    ['アレルギーはありますか？', 'Do you have any allergies?', ['ありません', 'arimasen', 'none'], ['エビがだめです', 'ebi ga dame desu', 'I can\'t eat shrimp'], ['ナッツアレルギーです', 'nattsu arerugii desu', 'I\'m allergic to nuts']],
    ['お箸は使えますか？', 'Can you use chopsticks?', ['はい、使えます', 'hai, tsukaemasu', 'yes, I can'], ['少しだけ', 'sukoshi dake', 'a little'], ['フォークはありますか', 'fooku wa arimasu ka', 'do you have a fork?']],
    ['以上でよろしいですか？', 'Will that be all?', ['はい、以上です', 'hai, ijou desu', 'yes, that\'s all'], ['もう一つお願いします', 'mou hitotsu onegaishimasu', 'one more, please'], ['お会計お願いします', 'okaikei onegaishimasu', 'the check, please']],
    ['お会計は別々にしますか？', 'Would you like separate checks?', ['一緒でお願いします', 'issho de onegaishimasu', 'together, please'], ['別々でお願いします', 'betsubetsu de onegaishimasu', 'separately, please'], ['カードは使えますか', 'kaado wa tsukaemasu ka', 'can I use a card?']],
    ['店内でお召し上がりですか？', 'Will you be eating here?', ['はい、ここで食べます', 'hai, koko de tabemasu', 'yes, I\'ll eat here'], ['持ち帰りでお願いします', 'mochikaeri de onegaishimasu', 'to go, please'], ['席は空いていますか', 'seki wa aite imasu ka', 'are there free seats?']],
    // Shops and paying
    ['お支払いは現金ですか、カードですか？', 'Cash or card?', ['カードでお願いします', 'kaado de onegaishimasu', 'by card, please'], ['現金で払います', 'genkin de haraimasu', 'I\'ll pay cash'], ['スマホで払えますか', 'sumaho de haraemasu ka', 'can I pay with my phone?']],
    ['袋はいりますか？', 'Do you need a bag?', ['はい、お願いします', 'hai, onegaishimasu', 'yes, please'], ['いいえ、大丈夫です', 'iie, daijoubu desu', 'no, I\'m fine'], ['小さい袋をください', 'chiisai fukuro o kudasai', 'a small bag, please']],
    ['ポイントカードはお持ちですか？', 'Do you have a point card?', ['いいえ、持っていません', 'iie, motte imasen', 'no, I don\'t'], ['はい、これです', 'hai, kore desu', 'yes, here it is'], ['作れますか', 'tsukuremasu ka', 'can I make one?']],
    ['温めますか？', 'Shall I heat it up?', ['はい、お願いします', 'hai, onegaishimasu', 'yes, please'], ['いいえ、大丈夫です', 'iie, daijoubu desu', 'no, thanks'], ['少しだけお願いします', 'sukoshi dake onegaishimasu', 'just a little, please']],
    ['レシートはいりますか？', 'Do you need the receipt?', ['はい、お願いします', 'hai, onegaishimasu', 'yes, please'], ['いいえ、いりません', 'iie, irimasen', 'no, I don\'t need it'], ['領収書をお願いします', 'ryoushuusho o onegaishimasu', 'an official receipt, please']],
    // Getting around
    ['どちらまでですか？', 'Where to?', ['この住所までお願いします', 'kono juusho made onegaishimasu', 'to this address, please'], ['駅までお願いします', 'eki made onegaishimasu', 'to the station, please'], ['空港までお願いします', 'kuukou made onegaishimasu', 'to the airport, please']],
    ['何かお探しですか？', 'Are you looking for something?', ['駅を探しています', 'eki o sagashite imasu', 'I\'m looking for the station'], ['トイレはどこですか', 'toire wa doko desu ka', 'where is the toilet?'], ['大丈夫です、ありがとう', 'daijoubu desu, arigatou', 'I\'m okay, thanks']],
    ['まっすぐ行って右です', 'Go straight and turn right', ['ありがとうございます', 'arigatou gozaimasu', 'thank you'], ['遠いですか', 'tooi desu ka', 'is it far?'], ['地図で見せてもらえますか', 'chizu de misete moraemasu ka', 'show me on the map?']],
    ['歩いて五分くらいです', 'It\'s about a five-minute walk', ['ありがとうございます', 'arigatou gozaimasu', 'thank you'], ['どちらの方向ですか', 'dochira no houkou desu ka', 'which direction?'], ['バスはありますか', 'basu wa arimasu ka', 'is there a bus?']],
    ['大丈夫ですか？', 'Are you all right?', ['はい、大丈夫です', 'hai, daijoubu desu', 'yes, I\'m fine'], ['ちょっと迷いました', 'chotto mayoimashita', 'I\'m a little lost'], ['助けてもらえますか', 'tasukete moraemasu ka', 'could you help me?']],
    ['写真を撮りましょうか？', 'Shall I take your photo?', ['はい、お願いします', 'hai, onegaishimasu', 'yes, please'], ['大丈夫です、ありがとう', 'daijoubu desu, arigatou', 'I\'m fine, thanks'], ['一緒に撮りませんか', 'issho ni torimasen ka', 'want to be in it with me?']],
  ],
};

export const STARTERS = {
  'es:en': build(es),
  'ja:en': build(ja),
};

/** Starter content for a language pair, or null. */
export const starterFor = (theirLang, myLang) => STARTERS[`${theirLang}:${myLang}`] ?? null;

// Instant replies for Q&A assist (same language), in the same fixed order as
// the banks above: slots 3-5 (repeat, slower, one moment) show while Claude
// works on an answer.
export const ASSIST_BANKS = {
  en: [
    'Yes', 'No', 'I\'m not sure I follow', 'Could you repeat the question?',
    'Could you say that once more?', 'Good question, give me a moment', 'Thank you',
    'Sorry about that', 'I don\'t know offhand, I can follow up', 'Sounds good',
  ].map((text) => ({ text, gloss: '', source: 'bank' })),
};
