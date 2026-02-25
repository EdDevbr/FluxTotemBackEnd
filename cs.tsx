version: "3.8"

services:
  mysql:
    image: mysql:8.0
    container_name: flux-mysql
    restart: always
    environment:
      MYSQL_DATABASE: flux_totem
      MYSQL_USER: fluxuser
      MYSQL_PASSWORD: USLFR6K88mVHe39
      MYSQL_ROOT_PASSWORD: Cs2Exp3rT01?not&t
    ports:
      - "3306:3306" # opcional (se não precisar acessar de fora, pode remover)
    volumes:
      - flux_mysql_data:/var/lib/mysql
    command: ["--default-authentication-plugin=mysql_native_password"]

  flux-totem-backend:
    build: .
    container_name: flux-totem-backend
    restart: always
    environment:
      PORT: 3333
      MYSQL_HOST: mysql
      MYSQL_USER: fluxuser
      MYSQL_PASS: USLFR6K88mVHe39
      MYSQL_DB: flux_totem

      MP_ACCESS_TOKEN: "APP_USR-54777091437386-022419-bde78d97ba8caa0b9ca29f0aed76b682-87084551"
    depends_on:
      - mysql

    # Traefik labels (HTTPS + domínio)
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.fluxtotem.rule=Host(`api.fluxpos.com.br`)"
      - "traefik.http.routers.fluxtotem.entrypoints=websecure"
      - "traefik.http.routers.fluxtotem.tls=true"
      - "traefik.http.routers.fluxtotem.tls.certresolver=letsencrypt"
      - "traefik.http.services.fluxtotem.loadbalancer.server.port=3333"

    networks:
      - network_public

volumes:
  flux_mysql_data:

networks:
  network_public:
    external: true