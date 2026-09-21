# Production wrapper.
#
#   ./docker-prod.sh build
#   ./docker-prod.sh up -d
#
# prod-compose.yml adds the MinIO object store. It is a separate layer, as
# local-compose.yml is, because docker-test.sh and `docker-local.sh --cloud`
# share the base file and both deliberately run without a MinIO container.
source prod.env
echo "Docker Compose Command: " $@
docker compose -f docker-compose.yml -f prod-compose.yml $@
