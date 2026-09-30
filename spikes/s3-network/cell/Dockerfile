FROM alpine:3.22
RUN apk add --no-cache curl bind-tools busybox-extras \
 && mkdir -p /www && echo cell-ok > /www/index.html
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
