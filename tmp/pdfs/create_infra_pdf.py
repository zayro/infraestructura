from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                KeepTogether, PageBreak, HRFlowable)

OUT = r"D:\\infraestructura\\output\\pdf\\guia-infraestructura.pdf"
W, H = A4
NAVY = HexColor("#102A43")
INK = HexColor("#243B53")
MUTED = HexColor("#627D98")
MINT = HexColor("#D9F5EE")
TEAL = HexColor("#007C78")
PALE = HexColor("#F5F8FA")
LINE = HexColor("#D9E2EC")
WHITE = colors.white

styles = getSampleStyleSheet()
def s(name, **kwargs):
    return ParagraphStyle(name, parent=styles['Normal'], **kwargs)

title = s('TitleX', fontName='Helvetica-Bold', fontSize=31, leading=35, textColor=NAVY, spaceAfter=9)
subtitle = s('SubX', fontName='Helvetica', fontSize=13, leading=19, textColor=MUTED)
kicker = s('Kick', fontName='Helvetica-Bold', fontSize=8.5, leading=11, textColor=TEAL, spaceAfter=5, uppercase=True)
h1 = s('H1', fontName='Helvetica-Bold', fontSize=22, leading=27, textColor=NAVY, spaceBefore=3, spaceAfter=13)
h2 = s('H2', fontName='Helvetica-Bold', fontSize=13, leading=17, textColor=INK, spaceAfter=6)
body = s('Body', fontName='Helvetica', fontSize=10.1, leading=15, textColor=INK, spaceAfter=7)
small = s('Small', fontName='Helvetica', fontSize=8.4, leading=11.5, textColor=MUTED)
cardtitle = s('CardTitle', fontName='Helvetica-Bold', fontSize=11, leading=14, textColor=NAVY, spaceAfter=4)
cardbody = s('CardBody', fontName='Helvetica', fontSize=9.1, leading=13, textColor=INK)
mono = s('Mono', fontName='Courier', fontSize=8.4, leading=12, textColor=INK)
tablehead = s('TH', fontName='Helvetica-Bold', fontSize=8.4, leading=10, textColor=WHITE)
tablecell = s('TC', fontName='Helvetica', fontSize=8.1, leading=10.5, textColor=INK)

def P(text, style=body): return Paragraph(text, style)
def card(head, text, width=82*mm):
    t = Table([[P(head, cardtitle), P(text, cardbody)]], colWidths=[width],
              style=[('BACKGROUND',(0,0),(-1,-1),WHITE),('BOX',(0,0),(-1,-1),0.6,LINE),
                     ('LEFTPADDING',(0,0),(-1,-1),10),('RIGHTPADDING',(0,0),(-1,-1),10),
                     ('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),10)])
    return t

def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE); canvas.setLineWidth(.4)
    canvas.line(18*mm, 14*mm, W-18*mm, 14*mm)
    canvas.setFont('Helvetica', 8); canvas.setFillColor(MUTED)
    canvas.drawString(18*mm, 8.5*mm, 'Guia de infraestructura - entorno de demostracion')
    canvas.drawRightString(W-18*mm, 8.5*mm, f'{doc.page}')
    canvas.restoreState()

doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=18*mm, rightMargin=18*mm, topMargin=18*mm, bottomMargin=20*mm)
story=[]

# Cover
story += [Spacer(1, 25*mm), P('INFRAESTRUCTURA', kicker), P('Una plataforma,\nexplicada para dos audiencias.', title),
          P('Guia visual y minimalista del entorno de microservicios, datos, mensajeria y observabilidad.', subtitle), Spacer(1, 23*mm)]
cover = Table([[P('<b>01</b><br/>Vista sencilla', cardbody), P('<b>02</b><br/>Vista tecnica', cardbody), P('<b>03</b><br/>Operacion', cardbody)]], colWidths=[55*mm]*3,
              style=[('BACKGROUND',(0,0),(-1,-1),MINT),('LINEABOVE',(0,0),(-1,0),1,TEAL),
                     ('LEFTPADDING',(0,0),(-1,-1),10),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),10)])
story += [cover, Spacer(1, 15*mm), P('Alcance: entorno autocontenido de desarrollo desplegado con Docker Compose. No representa todavia una arquitectura de produccion.', small)]
story.append(PageBreak())

# Non technical
story += [P('PARA USO GENERAL', kicker), P('La infraestructura en pocas palabras', h1),
 P('Es el conjunto de piezas que permite que una aplicacion reciba solicitudes, guarde informacion, procese tareas y muestre con claridad si todo esta funcionando.', body)]
story += [Table([[card('Una puerta de entrada', 'Traefik recibe todas las solicitudes. Es la recepcion: dirige cada pedido al servicio correcto y evita sobrecargas.'),
                 card('Dos servicios', 'La aplicacion se divide en dos servicios de prueba. Asi se valida que componentes distintos puedan trabajar de forma coordinada.')]], colWidths=[84*mm,84*mm], style=[('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),0),('RIGHTPADDING',(0,0),(-1,-1),0),('TOPPADDING',(0,0),(-1,-1),0),('BOTTOMPADDING',(0,0),(-1,-1),0)]), Spacer(1,6*mm)]
story += [Table([[card('Memoria y datos', 'PostgreSQL conserva la informacion importante. Redis acelera consultas frecuentes para que la respuesta sea mas rapida.'),
                 card('Trabajo en segundo plano', 'RabbitMQ lleva mensajes entre servicios. Esto permite continuar un proceso sin obligar al usuario a esperar.')]], colWidths=[84*mm,84*mm], style=[('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),0),('RIGHTPADDING',(0,0),(-1,-1),0),('TOPPADDING',(0,0),(-1,-1),0),('BOTTOMPADDING',(0,0),(-1,-1),0)])]
story += [Spacer(1, 11*mm), P('Como viaja una solicitud', h2),
 P('Persona o sistema <b>-></b> puerta de entrada <b>-></b> servicio adecuado <b>-></b> datos o mensaje <b>-></b> respuesta. Las rutas protegidas incluyen un JWT y Traefik valida su firma y rol antes de enviarlas al servicio. Mientras tanto, el entorno registra lo que ocurre para facilitar la operacion.', body),
 HRFlowable(width='100%', thickness=.7, color=LINE, spaceBefore=8, spaceAfter=10), P('Que se gana', h2),
 P('<b>Orden:</b> cada componente tiene una responsabilidad clara. &nbsp;&nbsp; <b>Velocidad:</b> la cache evita trabajo repetido. &nbsp;&nbsp; <b>Confianza:</b> metricas, registros y trazas ayudan a detectar y explicar incidentes.', body)]
story.append(PageBreak())

# Technical architecture
story += [P('PARA PERSONAS TECNICAS', kicker), P('Arquitectura y flujos', h1), P('Un unico proyecto Docker Compose organiza los componentes en la red interna <font name="Courier">demo-observability-net</font>. Los microservicios no exponen puertos al host.', body)]
diagram = Table([
 [P('<b>Cliente</b><br/><font size="8">HTTP :8000</font>', cardbody)],
 [P('<b>Traefik</b><br/><font size="8">routing, JWT/RBAC, rate limit, concurrencia, headers</font>', cardbody)],
 [P('<b>FastAPI</b> <font size="8">/api/test :8083</font> &nbsp;&nbsp;&nbsp; <b>Fastify</b> <font size="8">/api/node :8084</font>', cardbody)],
 [P('<b>PostgreSQL</b> <font size="8">datos persistentes</font> &nbsp;&nbsp; <b>Redis</b> <font size="8">cache-aside, TTL 30 s</font> &nbsp;&nbsp; <b>RabbitMQ</b> <font size="8">cola durable test.events</font>', cardbody)],
], colWidths=[168*mm], style=[('BACKGROUND',(0,0),(-1,0),MINT),('BACKGROUND',(0,1),(-1,1),HexColor('#EAF2F8')),('BACKGROUND',(0,2),(-1,2),WHITE),('BACKGROUND',(0,3),(-1,3),PALE),('BOX',(0,0),(-1,-1),.7,LINE),('INNERGRID',(0,0),(-1,-1),.6,LINE),('ALIGN',(0,0),(-1,-1),'CENTER'),('VALIGN',(0,0),(-1,-1),'MIDDLE'),('TOPPADDING',(0,0),(-1,-1),9),('BOTTOMPADDING',(0,0),(-1,-1),9)])
story += [diagram, Spacer(1,8*mm), P('Reglas de exposicion', h2), P('Solo Traefik publica la API en <font name="Courier">:8000</font>. PostgreSQL, Redis y RabbitMQ publican sus puertos en localhost para desarrollo; los servicios de aplicacion permanecen internos. Las rutas protegidas usan JWT firmados con un secreto HMAC local; no se despliega un proveedor de identidad. El gateway aplica 10 solicitudes/s por IP, rafaga de 20 y hasta 50 solicitudes simultaneas por defecto.', body)]
data = [[P('Componente',tablehead), P('Responsabilidad',tablehead), P('Detalle clave',tablehead)],
 [P('Traefik',tablecell),P('Gateway HTTP',tablecell),P('Rutas /api/test y /api/node; middleware de seguridad.',tablecell)],
 [P('PostgreSQL + Redis',tablecell),P('Persistencia y cache',tablecell),P('Volumenes persistentes; patron cache-aside.',tablecell)],
 [P('RabbitMQ',tablecell),P('Mensajeria asincrona',tablecell),P('FastAPI publica; Fastify consume y confirma manualmente.',tablecell)]]
story += [Table(data, colWidths=[35*mm,51*mm,82*mm], style=[('BACKGROUND',(0,0),(-1,0),NAVY),('GRID',(0,0),(-1,-1),.45,LINE),('VALIGN',(0,0),(-1,-1),'TOP'),('BACKGROUND',(0,1),(-1,-1),WHITE),('ROWBACKGROUNDS',(0,1),(-1,-1),[WHITE,PALE]),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6)])]
story.append(PageBreak())

# Observability + ops
story += [P('OPERACION', kicker), P('Observar, diagnosticar, actuar', h1), P('La observabilidad permite pasar de una alerta general a la causa concreta sin adivinar.', body)]
obs = [[P('<b>Metricas</b><br/><font size="8">Prometheus</font>',cardbody), P('<b>Trazas</b><br/><font size="8">OpenTelemetry -> Tempo</font>',cardbody), P('<b>Logs</b><br/><font size="8">OpenTelemetry -> Loki</font>',cardbody)],
       [P('¿Cuanto trafico, error o latencia hay?',small), P('¿En que paso se demoro o fallo la solicitud?',small), P('¿Que detalle explica el evento?',small)]]
story += [Table(obs, colWidths=[56*mm]*3, style=[('BACKGROUND',(0,0),(-1,0),MINT),('BOX',(0,0),(-1,-1),.6,LINE),('INNERGRID',(0,0),(-1,-1),.6,LINE),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),9),('BOTTOMPADDING',(0,0),(-1,-1),9)]), Spacer(1,9*mm), P('Grafana: una vista unificada', h2), P('Grafana conecta Prometheus, Loki y Tempo. El identificador <font name="Courier">trace_id</font> une una respuesta, su traza y sus logs: primero se detecta el problema en metricas, luego se ubica en la traza y por ultimo se explica con registros.', body), P('Interfaces de desarrollo', h2)]
links = [[P('API',tablehead),P('Grafana',tablehead),P('Prometheus',tablehead),P('Traefik',tablehead)],
         [P('localhost:8000',tablecell),P('localhost:3000',tablecell),P('localhost:9090',tablecell),P('localhost:8088/dashboard/',tablecell)]]
story += [Table(links, colWidths=[34*mm,39*mm,42*mm,53*mm], style=[('BACKGROUND',(0,0),(-1,0),NAVY),('GRID',(0,0),(-1,-1),.45,LINE),('ALIGN',(0,0),(-1,-1),'CENTER'),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)])]
story += [Spacer(1,10*mm), P('Limites actuales y siguiente paso', h2), P('Es un entorno de demostracion y desarrollo: Traefik valida JWT de prueba generados localmente, el dashboard usa configuracion insegura, no hay TLS y los secretos parten de valores de ejemplo. Para produccion, priorizar gestion de secretos, TLS, integracion con un proveedor de identidad si se requiere, endurecimiento de accesos, versionado inmutable de imagenes y alta disponibilidad.', body), Spacer(1,6*mm), P('Fuente: configuracion y documentacion del repositorio de infraestructura.', small)]

doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
